// =====================================================================
// src/lib/crypto.js の単体テスト
//   実行: node --test src/lib/crypto.test.js
//   依存ゼロ（Node標準 node:test / node:assert とネイティブWeb Cryptoのみ）。
//   ビルド不要。GitHub Pages配信物には含まれない開発時テスト。
// =====================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupSecretKeys,
  unlockWithPassphrase,
  unlockWithRecovery,
  rewrapForNewPassphrase,
  encryptNote,
  decryptNote,
  makeVerificationBlob,
  verifyMasterKey,
  generateRecoveryCode,
  normalizeRecoveryCode,
  generateMasterKey,
} from './crypto.js';

// ---------------------------------------------------------------------
// 1. 暗号化 → 復号のラウンドトリップ
// ---------------------------------------------------------------------
test('ノートの暗号化→復号ラウンドトリップ（日本語・記号・空文字）', async () => {
  const master = generateMasterKey();
  for (const plain of ['password: hunter2', 'ぱすわーど 🔒 ID:admin@x', '', 'a'.repeat(5000)]) {
    const blob = await encryptNote(master, plain);
    assert.notEqual(blob, plain, '暗号文が平文と同一であってはならない');
    const back = await decryptNote(master, blob);
    assert.equal(back, plain);
  }
});

test('同じ平文でもIVが毎回変わり暗号文が異なる', async () => {
  const master = generateMasterKey();
  const a = await encryptNote(master, 'secret');
  const b = await encryptNote(master, 'secret');
  assert.notEqual(a, b, 'IVランダム化により暗号文は毎回変わるべき');
  assert.equal(await decryptNote(master, a), 'secret');
  assert.equal(await decryptNote(master, b), 'secret');
});

test('別のマスター鍵では復号できない（改ざん/他人排除）', async () => {
  const m1 = generateMasterKey();
  const m2 = generateMasterKey();
  const blob = await encryptNote(m1, 'topsecret');
  await assert.rejects(() => decryptNote(m2, blob), 'GCM認証失敗で復号は例外になるべき');
});

// ---------------------------------------------------------------------
// 2. セットアップ & パスフレーズ解錠
// ---------------------------------------------------------------------
test('セットアップ後、正しいパスフレーズで解錠でき、誤りでは解錠できない', async () => {
  const { material, recoveryCode } = await setupSecretKeys('correct horse battery');
  assert.ok(material.kdf_salt && material.wrapped_master_key && material.verification_blob);
  assert.ok(material.wrapped_master_key_recovery);
  assert.ok(recoveryCode.includes('-'), 'リカバリーコードは区切り付きで表示される');

  const ok = await unlockWithPassphrase('correct horse battery', material);
  assert.ok(ok instanceof Uint8Array, '正しいパスフレーズでマスター鍵が得られる');

  const ng = await unlockWithPassphrase('wrong passphrase', material);
  assert.equal(ng, null, '誤ったパスフレーズは null');
});

test('パスフレーズ解錠で得たマスター鍵は検証ブロブと整合する', async () => {
  const { material } = await setupSecretKeys('pw');
  const master = await unlockWithPassphrase('pw', material);
  assert.equal(await verifyMasterKey(master, material.verification_blob), true);
});

test('セットアップで暗号化したノートを解錠後のマスター鍵で復号できる', async () => {
  const { material } = await setupSecretKeys('pw-123');
  const setupMaster = await unlockWithPassphrase('pw-123', material);
  const blob = await encryptNote(setupMaster, 'my api key = sk-xxxx');
  // 別セッションを模して再解錠
  const relockMaster = await unlockWithPassphrase('pw-123', material);
  assert.equal(await decryptNote(relockMaster, blob), 'my api key = sk-xxxx');
});

// ---------------------------------------------------------------------
// 3. リカバリーフロー（リカバリーコードからのマスター鍵アンラップ）
// ---------------------------------------------------------------------
test('リカバリーコードで同一のマスター鍵をアンラップできる', async () => {
  const { material, recoveryCode } = await setupSecretKeys('forgotten-pw');

  const viaPass = await unlockWithPassphrase('forgotten-pw', material);
  const viaRecovery = await unlockWithRecovery(recoveryCode, material);
  assert.ok(viaRecovery instanceof Uint8Array);
  assert.deepEqual([...viaRecovery], [...viaPass], 'パスフレーズ経路とリカバリー経路のマスター鍵は一致する');
});

test('リカバリーコードは区切り/大小文字の揺れを吸収して解錠できる', async () => {
  const { material, recoveryCode } = await setupSecretKeys('pw');
  const messy = recoveryCode.toLowerCase().replace(/-/g, ' ');
  const master = await unlockWithRecovery(messy, material);
  assert.ok(master instanceof Uint8Array, '小文字＋空白区切りでも解錠できる');
});

test('誤ったリカバリーコードでは解錠できない', async () => {
  const { material } = await setupSecretKeys('pw');
  const ng = await unlockWithRecovery('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', material);
  assert.equal(ng, null);
});

test('ノートをリカバリー経路のマスター鍵で復号できる', async () => {
  const { material, recoveryCode } = await setupSecretKeys('pw');
  const master = await unlockWithPassphrase('pw', material);
  const blob = await encryptNote(master, 'bank pin 4823');
  const recovered = await unlockWithRecovery(recoveryCode, material);
  assert.equal(await decryptNote(recovered, blob), 'bank pin 4823');
});

// ---------------------------------------------------------------------
// 4. パスフレーズ変更後も既存データが復号できること（再暗号化不要）
// ---------------------------------------------------------------------
test('パスフレーズ変更後、旧パスフレーズで暗号化した既存ノートが復号できる', async () => {
  const { material } = await setupSecretKeys('old-pass');
  const master = await unlockWithPassphrase('old-pass', material);

  // 既存 secret_note を暗号化して保存済みと想定
  const existingBlob = await encryptNote(master, 'legacy secret value');

  // パスフレーズ変更（マスター鍵を新パスフレーズ鍵で再ラップするだけ）
  const updated = await rewrapForNewPassphrase(master, 'new-pass', material);

  // 旧パスフレーズはもう通らない
  assert.equal(await unlockWithPassphrase('old-pass', updated), null);
  // 新パスフレーズで解錠
  const newMaster = await unlockWithPassphrase('new-pass', updated);
  assert.ok(newMaster instanceof Uint8Array);
  // 既存の暗号文（再暗号化していない）がそのまま復号できる
  assert.equal(await decryptNote(newMaster, existingBlob), 'legacy secret value');
});

test('パスフレーズ変更後もリカバリーコードは変わらず有効', async () => {
  const { material, recoveryCode } = await setupSecretKeys('old');
  const master = await unlockWithPassphrase('old', material);
  const updated = await rewrapForNewPassphrase(master, 'brand-new', material);
  // リカバリー用ラップは引き継がれるので、同じリカバリーコードで解錠できる
  const viaRecovery = await unlockWithRecovery(recoveryCode, updated);
  assert.ok(viaRecovery instanceof Uint8Array);
  assert.deepEqual([...viaRecovery], [...master]);
});

// ---------------------------------------------------------------------
// 5. リカバリーコード生成の健全性
// ---------------------------------------------------------------------
test('リカバリーコードは紛らわしい文字を含まず十分な長さを持つ', async () => {
  const code = generateRecoveryCode();
  const normalized = normalizeRecoveryCode(code);
  assert.equal(normalized.length, 24, '既定は24文字');
  assert.match(normalized, /^[A-Z0-9]+$/);
  assert.ok(!/[O0I1L]/.test(normalized), '紛らわしい文字(O,0,I,1,L)を含まない');
  // 毎回異なる
  assert.notEqual(generateRecoveryCode(), generateRecoveryCode());
});
