// =====================================================================
// Taskra シークレットメモ（E2EE）— UI/UX & 連携モジュール（タスク／ノート共通）
//
// index.html（巨大な単一ファイル）への影響を最小化するため、状態・DBアクセス・
// UI（ボトムシート/解錠/マスク表示など）をすべて自己完結で持つ。
// index.html 側は次のフックだけを呼ぶ：
//   window.SecretMemo.mountTaskSection(task)  … タスク詳細にセクションを差し込む
//   window.SecretMemo.mountNoteSection(note)  … ノート詳細にセクションを差し込む
//   window.SecretMemo.onNotesInput(el)        … 平文メモの入力を監視し検知チップ表示
//   window.SecretMemo.moveSecret(fromKind,fromId,toKind,toId) … タスク⇔ノート変換時の移行
//   window.SecretMemo.onEntityDeleted(kind,id) … 削除時の暗号文クリーンアップ
//
// 【重要・仕様上の制約】
//   secret_note は「検索対象外・AIアシスタント連携対象外・LINE通知対象外」。
//   平文・パスフレーズ・リカバリーコード・マスター鍵・導出鍵はサーバーへ送信しない／
//   localStorage・sessionStorage にも保存しない。マスター鍵はモジュールスコープ変数
//   _masterKey にのみ（メモリ上）保持する。
//
// 【鍵の共有設計】
//   鍵素材 secret_key_material は user_id 単位（1ユーザー＝1マスター鍵）。よって
//   合言葉・復元コードはタスクとノートで共通。タスク⇔ノート変換は、暗号文blobを
//   task_secret_notes ⇔ note_secret_notes 間でそのまま移し替えるだけで成立する
//   （AES-GCMのblobは対象idに束縛されないため復号不要・ロック中でも移行可能）。
// =====================================================================

import * as C from './lib/crypto.js';

// ---- メモリ上の鍵（ここ以外に保存しない） --------------------------------
let _masterKey = null;          // Uint8Array | null（解錠中のみ非null）
let _material = null;           // 鍵素材のキャッシュ（暗号文のみ。単体では復号不可）
let _materialLoadedFor = null;  // どのユーザーの鍵素材をロード済みか
let _clipboardTimer = null;
let _mountedEntity = null;      // 現在ドロワーに表示中のエンティティ {kind,id,ownerId}

const SB = () => window._SB;
const uid = () => (window._currentUser && window._currentUser.id) || null;
const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };

// エンティティ種別 → テーブル/主キー列の対応
function tableFor(kind) {
  return kind === 'note'
    ? { table: 'note_secret_notes', idCol: 'note_id' }
    : { table: 'task_secret_notes', idCol: 'task_id' };
}

// 所有者判定（共有時に所有者以外にはセクション自体を出さない）
function isOwner(ownerId) {
  if (!ownerId) return true; // 未保存の新規は自分のもの
  return !!uid() && ownerId === uid();
}
function ownerIdOf(obj) { return obj && (obj.user_id || obj.userId); }

function isUnlocked() { return _masterKey != null; }

// =====================================================================
// DB アクセス（すべて owner-only RLS 前提。暗号文のみ往復する）
// =====================================================================
async function loadMaterial(force) {
  if (!uid()) return null;
  if (!force && _material && _materialLoadedFor === uid()) return _material;
  const { data, error } = await SB()
    .from('secret_key_material')
    .select('kdf_salt,verification_blob,wrapped_master_key,wrapped_master_key_recovery')
    .eq('user_id', uid())
    .maybeSingle();
  if (error) { console.error('secret: loadMaterial', error); return null; }
  _material = data || null;
  _materialLoadedFor = uid();
  return _material;
}

async function saveMaterial(material) {
  const row = { user_id: uid(), ...material, updated_at: new Date().toISOString() };
  const { error } = await SB().from('secret_key_material').upsert(row, { onConflict: 'user_id' });
  if (error) { console.error('secret: saveMaterial', error); throw error; }
  _material = material;
  _materialLoadedFor = uid();
}

async function loadSecretBlob(kind, id) {
  if (!uid()) return null;
  const { table, idCol } = tableFor(kind);
  const { data, error } = await SB()
    .from(table).select('secret_note').eq(idCol, id).eq('user_id', uid()).maybeSingle();
  if (error) { console.error('secret: loadSecretBlob', error); return null; }
  return data ? data.secret_note : null;
}

async function saveSecretBlob(kind, id, blob) {
  const { table, idCol } = tableFor(kind);
  const row = { [idCol]: id, user_id: uid(), secret_note: blob, updated_at: new Date().toISOString() };
  const { error } = await SB().from(table).upsert(row, { onConflict: idCol });
  if (error) { console.error('secret: saveSecretBlob', error); throw error; }
}

async function deleteSecretBlob(kind, id) {
  const { table, idCol } = tableFor(kind);
  const { error } = await SB().from(table).delete().eq(idCol, id).eq('user_id', uid());
  if (error) console.error('secret: deleteSecretBlob', error);
}

// タスク⇔ノート変換時の暗号文移行（復号不要。blobをそのまま移し替え）
async function moveSecret(fromKind, fromId, toKind, toId) {
  if (!uid()) return false;
  try {
    const blob = await loadSecretBlob(fromKind, fromId);
    if (!blob) return false;                 // シークレットが無ければ何もしない
    await saveSecretBlob(toKind, toId, blob); // 先に移送先へコピー
    await deleteSecretBlob(fromKind, fromId); // 成功後に移送元を削除
    return true;
  } catch (e) { console.error('secret: moveSecret', e); return false; }
}

// エンティティ削除時のクリーンアップ（暗号文の迷子を防ぐ）。
// 鍵素材が存在すると分かっている場合のみ実行し、無駄なネットワーク往復を避ける。
async function onEntityDeleted(kind, id) {
  if (!uid() || !_material) return;
  await deleteSecretBlob(kind, id);
}

// =====================================================================
// スタイル注入（1回だけ）
// =====================================================================
function injectStyle() {
  if (document.getElementById('secret-memo-style')) return;
  const s = document.createElement('style');
  s.id = 'secret-memo-style';
  s.textContent = `
  .sm-block{margin-bottom:10px;border:1px solid var(--border);border-radius:10px;overflow:hidden}
  .sm-head{display:flex;align-items:center;gap:7px;padding:9px 11px;cursor:default;background:var(--bg2);font-size:13px;font-weight:600;color:var(--text)}
  .sm-head .sm-key{font-size:14px}
  .sm-badge{font-size:10px;color:#7c5cff;background:rgba(124,92,255,.12);border-radius:4px;padding:1px 6px;font-weight:700}
  .sm-body{padding:11px}
  .sm-note{font-size:11.5px;color:var(--text3);line-height:1.6;margin:0 0 9px}
  .sm-owner-note{font-size:11px;color:var(--text3);background:var(--bg2);border-radius:7px;padding:7px 9px;line-height:1.6;margin-bottom:9px;display:flex;gap:6px;align-items:flex-start}
  .sm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:38px;padding:0 14px;border-radius:9px;border:none;background:#7c5cff;color:#fff;font-size:13px;font-weight:700;cursor:pointer;width:100%}
  .sm-btn.sm-ghost{background:var(--bg2);color:var(--text);border:1px solid var(--border);font-weight:600}
  .sm-btn.sm-danger{background:none;color:#e5484d;border:1px solid var(--border);font-weight:600;height:34px}
  .sm-btn:disabled{opacity:.5;cursor:not-allowed}
  .sm-btnrow{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
  .sm-btnrow .sm-btn{width:auto;flex:1;min-width:120px}
  .sm-line{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:7px;background:var(--bg2);margin-bottom:5px;cursor:pointer;font-size:13.5px;line-height:1.6;word-break:break-word}
  .sm-line .sm-dot{color:var(--text3);letter-spacing:2px;user-select:none}
  .sm-line.sm-revealed{background:rgba(124,92,255,.06);cursor:text;user-select:text}
  .sm-line .sm-eye{margin-left:auto;flex-shrink:0;font-size:12px;color:var(--text3)}
  .sm-ta{width:100%;min-height:110px;border:1px solid var(--border);border-radius:9px;padding:10px;font-size:14px;line-height:1.7;resize:vertical;background:var(--bg);color:var(--text);box-sizing:border-box}
  .sm-meter{height:6px;border-radius:4px;background:var(--bg2);overflow:hidden;margin-top:7px}
  .sm-meter > i{display:block;height:100%;width:0;background:#e5484d;transition:width .2s,background .2s}
  .sm-meter-label{font-size:11px;color:var(--text3);margin-top:4px}
  .sm-input{width:100%;height:42px;border:1px solid var(--border);border-radius:9px;padding:0 12px;font-size:15px;background:var(--bg);color:var(--text);box-sizing:border-box}
  .sm-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;letter-spacing:1px;word-break:break-all;background:var(--bg2);border:1px dashed var(--border);border-radius:9px;padding:12px;line-height:1.9;text-align:center;color:var(--text)}
  .sm-chip{display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px 10px;border-radius:9px;background:rgba(124,92,255,.1);border:1px solid rgba(124,92,255,.25);font-size:12.5px;color:var(--text)}
  .sm-chip button{margin-left:auto;flex-shrink:0;background:#7c5cff;color:#fff;border:none;border-radius:7px;padding:6px 11px;font-size:12px;font-weight:700;cursor:pointer}
  .sm-chip .sm-chip-x{background:none;color:var(--text3);margin-left:4px;padding:6px 4px}
  .sm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;display:flex;align-items:flex-end;justify-content:center}
  @media(min-width:560px){.sm-overlay{align-items:center}}
  .sm-sheet{background:var(--bg);width:100%;max-width:460px;border-radius:18px 18px 0 0;padding:20px;box-sizing:border-box;max-height:min(90dvh,100%);overflow-y:auto;-webkit-overflow-scrolling:touch;box-shadow:0 -8px 40px rgba(0,0,0,.25)}
  @media(min-width:560px){.sm-sheet{border-radius:18px}}
  .sm-sheet h3{font-size:17px;font-weight:800;margin:0 0 6px;color:var(--text)}
  .sm-sheet p.sm-lead{font-size:12.5px;color:var(--text2);line-height:1.7;margin:0 0 14px}
  .sm-check{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--text2);line-height:1.6;margin:12px 0;cursor:pointer}
  .sm-err{font-size:12px;color:#e5484d;margin-top:8px;min-height:16px}
  .sm-link{background:none;border:none;color:#7c5cff;font-size:12.5px;font-weight:600;cursor:pointer;padding:6px 0;text-decoration:underline}
  `;
  document.head.appendChild(s);
}

// =====================================================================
// 汎用: モーダル（ボトムシート）
// =====================================================================
function openSheet(buildInner) {
  injectStyle();
  const overlay = document.createElement('div');
  overlay.className = 'sm-overlay';
  const sheet = document.createElement('div');
  sheet.className = 'sm-sheet';
  overlay.appendChild(sheet);

  // ---- キーボード対策（iOS/Android） -------------------------------------
  // ボトムシートは画面下端に固定されるため、ソフトキーボードが出ると下部の
  // 入力欄やボタンが隠れてしまう。position:fixed はレイアウトビューポート基準
  // なのでキーボード分は縮まない。VisualViewport（実際に見えている領域）へ
  // オーバーレイを追従させ、シートが常にキーボードの上に来るようにする。
  const vv = window.visualViewport;
  const syncViewport = () => {
    if (!vv) return;
    overlay.style.top = vv.offsetTop + 'px';
    overlay.style.left = vv.offsetLeft + 'px';
    overlay.style.width = vv.width + 'px';
    overlay.style.height = vv.height + 'px';
  };
  if (vv) {
    // inset:0 の bottom/right を打ち消してから可視領域に合わせる
    overlay.style.bottom = 'auto';
    overlay.style.right = 'auto';
    syncViewport();
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
  }

  const close = () => {
    if (vv) {
      vv.removeEventListener('resize', syncViewport);
      vv.removeEventListener('scroll', syncViewport);
    }
    overlay.remove();
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // 入力欄にフォーカスが移ったら、その欄を可視領域の中央付近へスクロールして
  // キーボードに隠れないようにする（VisualViewport 追従と併用）。
  sheet.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && typeof t.scrollIntoView === 'function' && /^(INPUT|TEXTAREA)$/.test(t.tagName)) {
      setTimeout(() => {
        try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_e) {}
      }, 150);
    }
  });

  document.body.appendChild(overlay);
  buildInner(sheet, close);
  return { overlay, sheet, close };
}

// パスフレーズ強度（0-4）。技術用語を出さず「弱い/普通/強い」で見せる
function strength(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}
function strengthView(pw) {
  const s = strength(pw);
  const pct = [8, 30, 55, 80, 100][s];
  const col = ['#e5484d', '#e5484d', '#f5a623', '#30a46c', '#30a46c'][s];
  const label = ['短すぎます', '弱い', 'もう少し', '良い', 'とても良い'][s];
  return { pct, col, label, ok: pw.length >= 8 };
}

// =====================================================================
// 初回セットアップ（2ステップ：パスフレーズ → リカバリーコード）
// =====================================================================
function openSetup(onDone) {
  openSheet((sheet, close) => {
    sheet.innerHTML = `
      <h3>🔒 あなただけのメモを作る</h3>
      <p class="sm-lead">ここに書いた内容は暗号化され、合言葉を知っているあなただけが読めます。<br>
      解錠に使う合言葉を決めてください。</p>
      <input class="sm-input" id="sm-pass" type="password" placeholder="合言葉（8文字以上）" autocomplete="new-password">
      <div class="sm-meter"><i id="sm-meter-bar"></i></div>
      <div class="sm-meter-label" id="sm-meter-label">8文字以上で入力してください</div>
      <input class="sm-input" id="sm-pass2" type="password" placeholder="もう一度入力" autocomplete="new-password" style="margin-top:10px">
      <div class="sm-err" id="sm-err"></div>
      <button class="sm-btn" id="sm-next" disabled>次へ</button>
      <button class="sm-link" id="sm-cancel" style="display:block;margin:6px auto 0">やめる</button>
    `;
    const pass = sheet.querySelector('#sm-pass');
    const pass2 = sheet.querySelector('#sm-pass2');
    const bar = sheet.querySelector('#sm-meter-bar');
    const label = sheet.querySelector('#sm-meter-label');
    const next = sheet.querySelector('#sm-next');
    const err = sheet.querySelector('#sm-err');
    const upd = () => {
      const v = strengthView(pass.value);
      bar.style.width = v.pct + '%'; bar.style.background = v.col; label.textContent = v.label;
      next.disabled = !(v.ok && pass.value === pass2.value);
      err.textContent = (pass2.value && pass.value !== pass2.value) ? '合言葉が一致しません' : '';
    };
    pass.addEventListener('input', upd);
    pass2.addEventListener('input', upd);
    sheet.querySelector('#sm-cancel').addEventListener('click', close);
    next.addEventListener('click', async () => {
      next.disabled = true; next.textContent = '準備中…';
      try {
        const { material, recoveryCode } = await C.setupSecretKeys(pass.value);
        await saveMaterial(material);
        _masterKey = await C.unlockWithPassphrase(pass.value, material);
        showRecoveryStep(sheet, close, recoveryCode, onDone);
      } catch (e) {
        console.error(e); err.textContent = '作成に失敗しました。もう一度お試しください。';
        next.disabled = false; next.textContent = '次へ';
      }
    });
    setTimeout(() => pass.focus(), 50);
  });
}

// ---- ステップ2: リカバリーコード表示 ----
function showRecoveryStep(sheet, close, code, onDone) {
  sheet.innerHTML = `
    <h3>🗝 復元用コードを保管してください</h3>
    <p class="sm-lead">合言葉を忘れても、このコードがあればメモを取り戻せます。
    <b>この画面でしか表示されません。</b>安全な場所に保存してください。</p>
    <div class="sm-code" id="sm-rcode">${code}</div>
    <div class="sm-btnrow">
      <button class="sm-btn sm-ghost" id="sm-copy">コピー</button>
      <button class="sm-btn sm-ghost" id="sm-dl">ダウンロード</button>
    </div>
    <label class="sm-check"><input type="checkbox" id="sm-saved"> 復元用コードを保存しました</label>
    <button class="sm-btn" id="sm-fin" disabled>はじめる</button>
  `;
  sheet.querySelector('#sm-copy').addEventListener('click', () => { copyText(code, false); toast('コピーしました'); });
  sheet.querySelector('#sm-dl').addEventListener('click', () => downloadText('taskra-recovery-code.txt', code));
  const chk = sheet.querySelector('#sm-saved');
  const fin = sheet.querySelector('#sm-fin');
  chk.addEventListener('change', () => { fin.disabled = !chk.checked; });
  fin.addEventListener('click', () => { close(); if (onDone) onDone(); });
}

// =====================================================================
// 解錠モーダル（パスフレーズ入力 → verification_blob で検証）
// =====================================================================
function openUnlock(onDone) {
  openSheet((sheet, close) => {
    sheet.innerHTML = `
      <h3>🔒 メモを解錠</h3>
      <p class="sm-lead">合言葉を入力すると、あなたのメモが読めるようになります。</p>
      <input class="sm-input" id="sm-pass" type="password" placeholder="合言葉" autocomplete="current-password">
      <div class="sm-err" id="sm-err"></div>
      <button class="sm-btn" id="sm-ok">解錠する</button>
      <button class="sm-link" id="sm-forgot" style="display:block;margin:10px auto 0">合言葉を忘れた</button>
    `;
    const pass = sheet.querySelector('#sm-pass');
    const err = sheet.querySelector('#sm-err');
    const ok = sheet.querySelector('#sm-ok');
    const attempt = async () => {
      ok.disabled = true; ok.textContent = '確認中…'; err.textContent = '';
      const material = await loadMaterial();
      const key = material ? await C.unlockWithPassphrase(pass.value, material) : null;
      if (key) { _masterKey = key; close(); if (onDone) onDone(); }
      else { err.textContent = '合言葉が違います'; ok.disabled = false; ok.textContent = '解錠する'; pass.select(); }
    };
    ok.addEventListener('click', attempt);
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
    sheet.querySelector('#sm-forgot').addEventListener('click', () => { close(); openRecovery(onDone); });
    setTimeout(() => pass.focus(), 50);
  });
}

// =====================================================================
// リカバリー（コード入力 → アンラップ → 新しい合言葉を設定＝再ラップ）
// =====================================================================
function openRecovery(onDone) {
  openSheet((sheet, close) => {
    sheet.innerHTML = `
      <h3>🗝 復元用コードで取り戻す</h3>
      <p class="sm-lead">保存しておいた復元用コードを入力し、新しい合言葉を設定します。</p>
      <input class="sm-input" id="sm-code" placeholder="復元用コード" autocomplete="off" spellcheck="false">
      <input class="sm-input" id="sm-newpass" type="password" placeholder="新しい合言葉（8文字以上）" autocomplete="new-password" style="margin-top:10px">
      <div class="sm-meter"><i id="sm-meter-bar"></i></div>
      <div class="sm-meter-label" id="sm-meter-label"></div>
      <div class="sm-err" id="sm-err"></div>
      <button class="sm-btn" id="sm-ok" disabled>取り戻す</button>
      <p class="sm-note" style="margin-top:12px">※ 合言葉と復元用コードの両方を紛失した場合は、メモを取り戻すことはできません。</p>
    `;
    const codeEl = sheet.querySelector('#sm-code');
    const npass = sheet.querySelector('#sm-newpass');
    const bar = sheet.querySelector('#sm-meter-bar');
    const label = sheet.querySelector('#sm-meter-label');
    const err = sheet.querySelector('#sm-err');
    const ok = sheet.querySelector('#sm-ok');
    const upd = () => {
      const v = strengthView(npass.value);
      bar.style.width = v.pct + '%'; bar.style.background = v.col; label.textContent = npass.value ? v.label : '';
      ok.disabled = !(codeEl.value.trim() && v.ok);
    };
    codeEl.addEventListener('input', upd);
    npass.addEventListener('input', upd);
    ok.addEventListener('click', async () => {
      ok.disabled = true; ok.textContent = '確認中…'; err.textContent = '';
      const material = await loadMaterial();
      const key = material ? await C.unlockWithRecovery(codeEl.value, material) : null;
      if (!key) { err.textContent = '復元用コードが違います'; ok.disabled = false; ok.textContent = '取り戻す'; return; }
      try {
        const updated = await C.rewrapForNewPassphrase(key, npass.value, material);
        await saveMaterial(updated);
        _masterKey = key;
        close(); toast('新しい合言葉を設定しました'); if (onDone) onDone();
      } catch (e) { console.error(e); err.textContent = '設定に失敗しました'; ok.disabled = false; ok.textContent = '取り戻す'; }
    });
    setTimeout(() => codeEl.focus(), 50);
  });
}

// =====================================================================
// 合言葉の変更（現行で検証済みの鍵を新合言葉で再ラップ。再暗号化不要）
// =====================================================================
function openChangePass(onDone) {
  if (!isUnlocked()) { openUnlock(() => openChangePass(onDone)); return; }
  openSheet((sheet, close) => {
    sheet.innerHTML = `
      <h3>合言葉を変える</h3>
      <p class="sm-lead">新しい合言葉を設定します。メモの中身はそのまま読めます。</p>
      <input class="sm-input" id="sm-newpass" type="password" placeholder="新しい合言葉（8文字以上）" autocomplete="new-password">
      <div class="sm-meter"><i id="sm-meter-bar"></i></div>
      <div class="sm-meter-label" id="sm-meter-label"></div>
      <div class="sm-err" id="sm-err"></div>
      <button class="sm-btn" id="sm-ok" disabled>変更する</button>
      <button class="sm-link" id="sm-cancel" style="display:block;margin:6px auto 0">やめる</button>
    `;
    const npass = sheet.querySelector('#sm-newpass');
    const bar = sheet.querySelector('#sm-meter-bar');
    const label = sheet.querySelector('#sm-meter-label');
    const ok = sheet.querySelector('#sm-ok');
    npass.addEventListener('input', () => {
      const v = strengthView(npass.value);
      bar.style.width = v.pct + '%'; bar.style.background = v.col; label.textContent = npass.value ? v.label : '';
      ok.disabled = !v.ok;
    });
    sheet.querySelector('#sm-cancel').addEventListener('click', close);
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        const material = await loadMaterial();
        const updated = await C.rewrapForNewPassphrase(_masterKey, npass.value, material);
        await saveMaterial(updated);
        close(); toast('合言葉を変更しました'); if (onDone) onDone();
      } catch (e) { console.error(e); sheet.querySelector('#sm-err').textContent = '変更に失敗しました'; ok.disabled = false; }
    });
    setTimeout(() => npass.focus(), 50);
  });
}

// =====================================================================
// クリップボード / ダウンロード ユーティリティ
// =====================================================================
function copyText(text, autoClear) {
  const done = () => {
    if (autoClear) {
      if (_clipboardTimer) clearTimeout(_clipboardTimer);
      _clipboardTimer = setTimeout(async () => {
        try { await navigator.clipboard.writeText(''); } catch (_e) {}
        toast('クリップボードを消去しました');
      }, 30000);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else { fallbackCopy(text, done); }
}
function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (_e) {}
  ta.remove(); if (cb) cb();
}
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

// =====================================================================
// 詳細セクション描画（タスク／ノート共通）
// =====================================================================
const OWNER_NOTE = 'このメモはあなた専用です。共有しても相手には表示されません。検索・AI・LINE通知の対象外です。';

function sectionEl() { return document.getElementById('secret-memo-section'); }

async function renderSection(entity) {
  const host = sectionEl();
  if (!host) return;
  const material = await loadMaterial();

  if (!material) {
    host.innerHTML = block(`
      <p class="sm-note">パスワードやIDなど、あなただけが読めるメモを追加できます。端末の中で暗号化され、あなただけが読めます。</p>
      <button class="sm-btn" id="sm-setup">🔒 シークレットメモを設定</button>
    `);
    host.querySelector('#sm-setup').addEventListener('click', () => openSetup(() => renderSection(entity)));
    return;
  }

  if (!isUnlocked()) {
    host.innerHTML = block(`
      <p class="sm-note">合言葉で解錠すると、このシークレットメモが読めます。</p>
      <button class="sm-btn" id="sm-unlock">🔒 タップして解錠</button>
    `);
    host.querySelector('#sm-unlock').addEventListener('click', () => openUnlock(() => renderSection(entity)));
    return;
  }

  // 解錠済み：本文を取得・復号してマスク表示
  let plain = '';
  const blob = await loadSecretBlob(entity.kind, entity.id);
  if (blob) {
    try { plain = await C.decryptNote(_masterKey, blob); }
    catch (e) { console.error('secret: decrypt', e); plain = ''; }
  }
  host.innerHTML = block(`
    <div class="sm-owner-note"><span>🛡</span><span>${OWNER_NOTE}</span></div>
    <div id="sm-view"></div>
    <textarea class="sm-ta" id="sm-edit" placeholder="ここに書いた内容はあなただけが読めます…" style="display:none"></textarea>
    <div class="sm-btnrow">
      <button class="sm-btn sm-ghost" id="sm-editbtn">${plain ? '編集' : '書く'}</button>
      <button class="sm-btn sm-ghost" id="sm-copybtn" ${plain ? '' : 'style="display:none"'}>コピー</button>
    </div>
    <div class="sm-btnrow">
      <button class="sm-btn sm-danger" id="sm-changepass">合言葉を変える</button>
      <button class="sm-btn sm-danger" id="sm-lockbtn">今すぐロック</button>
    </div>
  `);
  const view = host.querySelector('#sm-view');
  const edit = host.querySelector('#sm-edit');
  const editBtn = host.querySelector('#sm-editbtn');
  const copyBtn = host.querySelector('#sm-copybtn');

  renderMaskedLines(view, plain);

  editBtn.addEventListener('click', async () => {
    if (edit.style.display === 'none') {
      edit.value = plain; edit.style.display = 'block'; view.style.display = 'none';
      editBtn.textContent = '保存'; edit.focus();
    } else {
      editBtn.disabled = true;
      const val = edit.value;
      try {
        if (val.trim() === '') { await deleteSecretBlob(entity.kind, entity.id); }
        else { await saveSecretBlob(entity.kind, entity.id, await C.encryptNote(_masterKey, val)); }
        plain = val;
        edit.style.display = 'none'; view.style.display = '';
        renderMaskedLines(view, plain);
        editBtn.textContent = plain ? '編集' : '書く';
        copyBtn.style.display = plain ? '' : 'none';
        updateSecretBadge(!!plain);
        toast('保存しました');
      } catch (e) { console.error(e); toast('保存に失敗しました'); }
      editBtn.disabled = false;
    }
  });
  copyBtn.addEventListener('click', () => { copyText(plain, true); toast('コピーしました（30秒後に自動消去）'); });
  host.querySelector('#sm-changepass').addEventListener('click', () => openChangePass(() => renderSection(entity)));
  host.querySelector('#sm-lockbtn').addEventListener('click', () => { lock(); renderSection(entity); });

  updateSecretBadge(!!plain);
}

// 本文を行単位でマスク表示。行タップで表示/再マスク（覗き見対策）
function renderMaskedLines(view, plain) {
  view.style.display = '';
  if (!plain) { view.innerHTML = '<p class="sm-note">まだ何も書かれていません。「書く」から追加できます。</p>'; return; }
  const lines = plain.split('\n');
  view.innerHTML = lines.map((ln, i) =>
    `<div class="sm-line" data-i="${i}"><span class="sm-dot">${'●'.repeat(Math.min(Math.max(ln.length, 4), 14))}</span><span class="sm-eye">タップで表示</span></div>`
  ).join('');
  view.querySelectorAll('.sm-line').forEach((el) => {
    const idx = +el.dataset.i;
    el.addEventListener('click', () => {
      const revealed = el.classList.toggle('sm-revealed');
      if (revealed) el.innerHTML = `<span>${escapeHtml(lines[idx] || ' ')}</span><span class="sm-eye">タップで隠す</span>`;
      else el.innerHTML = `<span class="sm-dot">${'●'.repeat(Math.min(Math.max((lines[idx] || '').length, 4), 14))}</span><span class="sm-eye">タップで表示</span>`;
    });
  });
}

function block(inner) {
  return `<div class="sm-block">
    <div class="sm-head"><span class="sm-key">🔒</span><span>シークレットメモ</span><span class="sm-badge" id="sm-has-badge" style="display:none">あり</span></div>
    <div class="sm-body">${inner}</div>
  </div>`;
}
function updateSecretBadge(has) {
  const b = document.getElementById('sm-has-badge');
  if (b) b.style.display = has ? '' : 'none';
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// =====================================================================
// 平文メモ内のパスワードらしきパターン検知（ローカル完結・送信禁止）
// =====================================================================
const PW_PATTERNS = [
  /pass(word|code)?\s*[:：=]/i,
  /\bPW\s*[:：=]/i,
  /(パスワード|ぱすわーど|暗証番号|合言葉)\s*[:：=]?/,
  /\bID\s*[:：=].*[!-\/:-@]/i,
  /\b[A-Za-z0-9]{6,}[!-\/:-@][A-Za-z0-9!-\/:-@]{2,}/,
];
function detectSensitiveLine(text) {
  const lines = String(text || '').split('\n');
  for (const ln of lines) {
    if (ln.trim().length < 4) continue;
    if (PW_PATTERNS.some((re) => re.test(ln))) return ln;
  }
  return null;
}

// index.html から呼ばれる：平文メモ入力を監視して提案チップを出す。
// 対象エンティティは現在マウント中のもの（_mountedEntity）を用いる。
function onNotesInput(notesEl) {
  const entity = _mountedEntity;
  if (!entity || !notesEl) return;
  const host = sectionEl();
  if (!host) return;
  const hit = detectSensitiveLine(notesEl.value);
  let chip = document.getElementById('sm-detect-chip');
  if (!hit) { if (chip) chip.remove(); return; }
  if (chip && chip._line === hit) return;
  if (!chip) {
    chip = document.createElement('div');
    chip.className = 'sm-chip'; chip.id = 'sm-detect-chip';
    host.parentNode.insertBefore(chip, host);
  }
  chip._line = hit;
  chip.innerHTML = `<span>🔒 パスワードらしき行を見つけました。シークレットメモに移動しますか？</span>
    <button id="sm-chip-move">移動</button><button class="sm-chip-x" id="sm-chip-x">×</button>`;
  chip.querySelector('#sm-chip-x').addEventListener('click', () => chip.remove());
  chip.querySelector('#sm-chip-move').addEventListener('click', () => moveLineToSecret(entity, notesEl, hit, chip));
}

// 検知した行を平文メモから除去し、シークレットメモへ移動＋暗号化保存（ワンタップ）
async function moveLineToSecret(entity, notesEl, line, chip) {
  const doMove = async () => {
    try {
      const cur = await loadSecretBlob(entity.kind, entity.id);
      let plain = '';
      if (cur) { try { plain = await C.decryptNote(_masterKey, cur); } catch (_e) {} }
      const merged = (plain ? plain + '\n' : '') + line;
      await saveSecretBlob(entity.kind, entity.id, await C.encryptNote(_masterKey, merged));
      const lines = notesEl.value.split('\n');
      const idx = lines.indexOf(line);
      if (idx >= 0) lines.splice(idx, 1);
      notesEl.value = lines.join('\n');
      notesEl.dispatchEvent(new Event('input', { bubbles: true })); // 既存autosaveを発火
      if (chip) chip.remove();
      await renderSection(entity);
      updateSecretBadge(true);
      toast('シークレットメモに移動しました');
    } catch (e) { console.error(e); toast('移動に失敗しました'); }
  };
  const material = await loadMaterial();
  if (!material) { openSetup(doMove); return; }
  if (!isUnlocked()) { openUnlock(doMove); return; }
  await doMove();
}

// =====================================================================
// 自動ロック：バックグラウンド移行で即ロック＋メモリ上の鍵破棄
// =====================================================================
function lock() {
  if (_masterKey) { try { _masterKey.fill(0); } catch (_e) {} }
  _masterKey = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    lock();
    const host = sectionEl();
    if (host) host.innerHTML = ''; // 表示中の平文行をDOMに残さない
  } else if (document.visibilityState === 'visible') {
    if (sectionEl() && _mountedEntity) renderSection(_mountedEntity);
  }
});

// =====================================================================
// マウント（タスク／ノート共通の内部関数 + 種別ごとのラッパ）
// =====================================================================
function mountSection(entity, anchorEl) {
  injectStyle();
  const old = sectionEl(); if (old) old.remove();
  const oldChip = document.getElementById('sm-detect-chip'); if (oldChip) oldChip.remove();

  // 共有時、所有者以外には「読めない欄」を一切見せない（UIレベルで非表示）
  if (!isOwner(entity.ownerId)) { _mountedEntity = null; return; }
  _mountedEntity = entity;

  const host = document.createElement('div');
  host.id = 'secret-memo-section';
  host.style.marginBottom = '10px';
  if (anchorEl && anchorEl.parentNode) anchorEl.parentNode.insertBefore(host, anchorEl.nextSibling);
  else {
    const body = document.querySelector('#drawer .drawer-body');
    if (body) body.appendChild(host); else return;
  }
  renderSection(entity);
}

function mountTaskSection(task) {
  const entity = { kind: 'task', id: task.id, ownerId: ownerIdOf(task) };
  mountSection(entity, document.getElementById('memo-section'));
}

function mountNoteSection(note) {
  // ノートのメモ欄（#nt-body）を含むブロックの直後に差し込む
  const bodyEl = document.getElementById('nt-body');
  const anchor = bodyEl ? bodyEl.closest('.drawer-body > div') || bodyEl.parentNode : null;
  const entity = { kind: 'note', id: note.id, ownerId: ownerIdOf(note) };
  mountSection(entity, anchor);
}

window.SecretMemo = {
  mountTaskSection, mountNoteSection, onNotesInput,
  moveSecret, onEntityDeleted, lock,
};
