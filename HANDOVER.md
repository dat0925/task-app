# Taskra（タスクラ）引き継ぎ書

最終更新: 2026-08-24

---

## 最大化ビューの再設計：Phase 2「配線の一本化」（2026-08-24）

Phase 1（セクションの部品化）の続き。全体像は提案書を参照:
https://claude.ai/code/artifact/cd6fdb02-430d-4ad9-a957-92ceba2ac6cc

### 何が問題だったか

`openExpandModal()` は `modal.innerHTML = dr.innerHTML` でドロワーのDOMを複製していた。
その結果 **document 内に同じ id が2つ存在する**状態になる。

`renderDrawer()` の配線はほぼ全部 `document.getElementById('dt-title')` の形で書かれており、
DOM順ではドロワー（`.layout` の中）がモーダル（`body` の末尾）より前なので、**必ずドロワー側を掴む**。
だからモーダル用にもう一度同じ配線を書く必要があり、それが `reattachModalEvents()`（約210行）だった。

書き写しなので**漏れがそのまま機能差になる**。実測で確認した差:

| 拡大表示での症状 | 原因 |
|---|---|
| 「📌 親タスクのタイトル」が無反応 | `sub-parent-btn` の配線が無い |
| サブタスクをドラッグで並び替えられない | `initSubDrag()` を呼んでいない |
| メモの ▼ を押すと裏のドロワー側が開閉する | `window._dtMemoToggle` がグローバル1枠で、ドロワー側の実装が入っている |
| プレビューをクリックしても編集に入らない | ドロワー側は click、モーダル側は長押し（touch）のみ |
| 曜日ラベルに色が付かない／日付スタイルが当たらない | `wdColor()` / `applyDateInputStyleFixed()` の呼び出しが無い |
| タグを切り替えるとスクロールが先頭に戻る | `if(!modal)` でスクロール復元を飛ばしていた |
| 計画開始日を変えても保存されない | `save()` の対象に `plannedStartAt` が無い |
| 自動保存の全損ガードが無い | `drEl._taskId !== t2.id` のチェックが無い（2026-08-01の全損事故の再発防止策） |
| Inbox→active の昇格・並び順・最近使った案件の記録が起きない | autosave の該当処理が無い |

### どう直したか

**`#drawer` 要素そのものをモーダルへ移動する。** DOMをコピーしない。

```js
_expandState={ov,type,parent:dr.parentNode,next:dr.nextSibling};
modal.appendChild(dr);          // ← コピーではなく移動
```

id は一意のままなので `renderDrawer()` の既存の配線がそのまま効く。イベントリスナは
ノードに付いているので移動しても生き残る。非同期ロード（コメント・添付・シークレットメモ）も
同じノードを対象にしているので効く。**モーダル専用の配線が要らなくなった。**

- `reattachModalEvents()` を削除（約210行）
- `syncExpandModal()` を削除。呼び出し3ヶ所（`pri` / `pri-cycle` / `tog-tag`）は
  直前の `renderDrawer()` だけで足りる
- `closeExpandModal(rerender=true)` を新設
- `renderDrawer` / `renderNoteDrawer` が閉じる分岐でも先に畳む
- 拡大表示中は main の幅制限を計算しない（モーダル幅 860px を引いて main が潰れる）
- ヘッダの最大化ボタンは開閉トグルにした（モーダル内にも同じボタンが出るため）

差分は **79行追加 / 268行削除**。

> [!danger] オーバーレイを消す前に必ずドロワーを元へ戻す
> `ov.remove()` を先にやると、**ドロワー要素ごと DOM から消える**（モーダルの子なので）。
> `closeExpandModal` は必ず `st.parent.insertBefore(dr, st.next)` を先に実行する。
> 閉じる経路は Escape / 背景クリック / 最大化トグル / ✕ / `renderDrawer` の早期return と
> 5つあるので、全部を1つの関数に集約してある。

### 併せて直した元からの不具合

**計画開始日（ガント開始日）だけを変更すると保存されない。** 拡大表示ではなく
**ドロワー単体でも再現する**。`dt-planned-start` は autosave の保存対象には入っていたが、
`change` を張る対象リストから漏れていたため保存が走らなかった。他の欄を触ったときに
一緒に保存されるので、気づきにくい形で消えていた。曜日ラベルも更新されていなかった。

### 検証したこと（ローカル実機・合成タスク）

- 拡大時にドロワーがモーダル内へ移動し、**重複idが0**になること
  （`dt-title` / `dt-planned-start` / `cm-list` / `autosave-ind` すべて1件）
- `document.getElementById` が移動後の要素を返すこと
- 閉じ方4種すべてでドロワーが元の位置（`.layout` の3/3）へ戻り、オーバーレイが残らないこと
- 二重に `openExpandModal` しても重複が出ないこと
- メモ開閉・📌ボタン・プレビュークリック・ドラッグハンドル・繰り返し曜日の復元
- 計画開始日の変更でドロワー/拡大表示の両方で `saveTask` が呼ばれること
- ノートの拡大・編集・保存・閉じる
- コンソール例外なし／`node --check` OK

> [!warning] ブラウザのHTTPキャッシュで古いJSを検証してしまった
> `python -m http.server` は `Last-Modified` を返すので、同じURLを再訪すると
> **条件付きリクエストで 304 が返り、古い `index.html` が使われることがある**。
> 「修正したのに直っていない」と1回誤診した。`?v=xxx` を付けて開くこと。
> ページ側で確認するなら `document.documentElement.outerHTML.includes('目印')`。

### 挙動が変わった点（意図的）

- 拡大表示中はドロワーが右側に残らない（要素自体がモーダルへ移るため）。
  従来は同じ内容が2枚表示されていた
- ヘッダの最大化ボタンが開閉トグルになった
- Escape は従来どおり**拡大とドロワーの両方**が閉じる（グローバルの Escape ハンドラが
  `S.drawerOpen=false` にするため）。提案書では「Escape でドロワーへ戻る」を挙げているが、
  これは Phase 3 で扱う

### 次にやること（Phase 3）

`<dialog>` ＋コンテナクエリで3ゾーン（属性レール / 本文 / コメント）の器を作り、
Phase 1 の部品を配置する。集中モード側ではアコーディオンを常時展開。ヘッダにパンくずと
前後移動（`↑`/`↓`、`J`/`K`）。URL は既に `#task/<id>` を持っているので `history.pushState` で
戻るボタンから閉じられるようにする。

Phase 2 で配線が1系統になったので、**器のHTMLを差し替えるだけで済む**ようになっている。

### セキュリティ関連の状態

- **新規/変更したテーブル: なし。** RLS の状態に変更なし
- **認証・決済フローの変更: なし。** Stripe の Webhook・Edge Function・料金プランに未接触
- 保存経路は既存の `saveTask()` / `saveNote()` のまま。追加ライブラリなし
- **触っていない箇所**: `renderNoteDrawer` の本文生成（ノート側の部品化は Phase 3）、
  `initComments` / `initAttachments` / `SecretMemo`（配線が一本化されたので手を入れる必要が無くなった）

---

## 最大化ビューの再設計：Phase 1「セクションの部品化」（2026-08-24）

### 背景

PC/iPad の「最大化」（`data-a="drawer-expand"` / `task-expand"` / `note-expand"`）が
**ドロワーの縦1列レイアウトをそのまま広げるだけ**で、見やすくならないという指摘を受けての作業。
再設計の全体像は提案書にまとめてある（設計方針・レイアウト4種・技術選定・段取り）:
https://claude.ai/code/artifact/cd6fdb02-430d-4ad9-a957-92ceba2ac6cc

診断（コード上の事実）:

| 症状 | 実装上の原因 |
|---|---|
| 幅だけ2.7倍になり構造は同一 | `openExpandModal()` が `modal.innerHTML=dr.innerHTML` で複製。箱が `336px`→`min(90vw,860px)` になるだけ |
| アコーディオンが閉じたまま開く | `dt-section-head`/`dt-section-body` の折りたたみ状態を引き継ぐ。一望したいのに ▼ を4回押す |
| 一覧が暗幕で隠れる | `.expand-overlay{background:rgba(0,0,0,.45)}`。ドロワーの「一覧と併置できる」利点まで失う |
| 機能が二重管理 | `reattachModalEvents()` が約200行、ドロワーのロジックを書き写している。2026-08-23 の URL リンク化不具合（`b16544f`）の原因はこれ |

目標のレイアウト（集中モード）: **細いレール＝属性 / 広い中央＝メモ・サブタスク / 右＝コメント**。
属性は値が短く幅を必要としないのでレールに寄せ、空いた中央をメモに渡す。

### この回でやったこと

**コミット `4be5a08`：`renderDrawer` の巨大1行を折り返す**

`renderDrawer` 内の文字列連結が1行 5122 / 4545 / 1760 文字に潰れていて、セクション単位で
読むことも切り出すこともできなかった。文字列リテラルの外にある「空白4つ以上 + `+`」の位置だけで
折り返した（`+` の前に改行を入れるだけなので ASI は起きない）。

**コミット `9e52714`：セクションを部品関数に切り出す**

`renderDrawer` 内に一体で書かれていた HTML 生成を、セクション単位の関数へ分割した。
`renderDrawer` はそれを連結して組み立てるだけになっている。

```
dr.innerHTML=
  _dtHead(c)
  +'<div class="drawer-body">'
    +_dtNav(c) +_dtIdentity(c) +_dtProject(c) +_dtSchedule(c)
    +_dtMemo(c) +_dtSubs(c) +_attSectionHTML('task',task.id) +_dtComments(c)
  +_dtMeta(c)
  +'</div>'
  +_dtFoot(c);
```

| 部品 | 中身 |
|---|---|
| `_dtHead` | ヘッダ（フラグ・最大化・複製・削除） |
| `_dtNav` | 親タスクの表示とセクションへのジャンプバッジ |
| `_dtIdentity` | タイトル・優先度・タグ |
| `_dtProject` | プロジェクトと担当者 |
| `_dtSchedule` | スケジュール（開始日・開始時間・期限・計画開始日・繰り返し） |
| `_dtMemo` | メモ |
| `_dtSubs` | サブタスク |
| `_dtComments` | コメント |
| `_dtMeta` | 作成/更新日時と自動保存の表示 |
| `_dtFoot` | フッタ（完了ボタン・モバイル操作バー） |

引数は `c = {task, subs, done, pLabels}`（`renderDrawer` 内で組み立てて渡す）。
**HTML の文字列は1文字も書き換えていない。** 連結の途中に関数境界を入れただけなので、
出力される HTML は従来と同一。

### 検証したこと

1. **各領域の括弧・引用符が閉じていることを機械的に確認**（＝トップレベルの `+` で切断できている）
2. **旧版（`4be5a08`）の式と新版の部品を node 上で同じ入力に対して実行し、出力HTMLを文字列比較。**
   10パターン（素のタスク / 全部入り / 子タスク / 完了 / 繰り返し weekly・monthly・daily・
   `weekdays` 互換 / スマホ幅 500px / タグ0件・案件0件 / サブタスクあり / recent なし）で
   **バイト単位で完全一致**を確認した。
3. 主要スクリプトブロックを `node --check` → OK
4. ローカル（`python -m http.server`）で実際に描画。合成タスクを `S.tasks` に入れて
   `renderDrawer()` → 全セクションが描画され、繰り返しの曜日チェック（月水金）も復元される。
   `openExpandModal('task')` も従来どおり 860px で開く。`renderNoteDrawer()` も正常。
   コンソールエラーなし。

検証スクリプトは一時ディレクトリに置いた（リポジトリには入れていない）。同じ検証をやり直すなら、
旧コミットの `index.html` から式の行範囲を取り出して関数化した新版と突き合わせる、という手順を再現すればよい。

### 途中で踏んだ罠（次に同じことをする人向け）

切り出しスクリプトが `const c={task,subs,done,pLabels};` を **`renderNoteDrawer` 側に挿入していた。**
`dr.innerHTML=` という行が `renderNoteDrawer`（先に定義されている）にも存在するため、
最初にマッチした方に入ってしまった。`node --check` は通る（構文としては正しい）ので、
**構文チェックだけでは検出できない**。ノートを開いた瞬間に `ReferenceError` になるところだった。
`renderDrawer` の関数開始位置を先に特定してから、その後ろで探すこと。

### 次にやること（Phase 2 以降）

- **Phase 2**: イベントの二重管理をやめる。`reattachModalEvents()`（約200行）を削除し、既存の
  `document` レベルの `data-a` 委譲（`el.closest('.expand-modal,#drawer')` で文脈判定している）に
  寄せる。`syncExpandModal()` は部品の差し替えに置き換える。自動保存も `renderDrawer` 側の1系統に統合。
  ここまで終えると、ドロワーに足した機能が集中モードにも自動で入るようになる。
- **Phase 3**: `<dialog>` ＋コンテナクエリで3ゾーンの器を作り、Phase 1 の部品を配置する。
  集中モード側ではアコーディオンを常時展開。ヘッダにパンくずと前後移動（`↑`/`↓`、`J`/`K`）を追加。
  URL は既に `#task/<id>` を持っているので `history.pushState` して戻るボタンで閉じられるようにする。
- **Phase 4**（任意）: メモの「編集/プレビュー」トグル廃止（クリック位置から編集）、
  `field-sizing:content` による自動伸長と `max-height:320px` ＋「もっと見る」の撤去、
  View Transitions、iPad 向けにタップ領域を 44px 以上へ。

### セキュリティ関連の状態

- **新規/変更したテーブル: なし。** RLS の状態に変更なし。
- **認証・決済フローの変更: なし。** Stripe の Webhook・Edge Function・料金プランに触れていない。
- 保存経路も既存の `saveTask()` / `saveNote()` のまま。追加ライブラリなし。
- **触っていない箇所**: `renderNoteDrawer`（ノート側の部品化は Phase 3 で扱う）、
  `reattachModalEvents`（Phase 2 で削除予定なので今回は手を付けない）、
  `openExpandModal` / `syncExpandModal`。

---

## 拡大モーダルのメモで素のURLがリンクにならない不具合の修正（2026-08-23）

### 症状
タスク行の拡大ボタン（`data-a="task-expand"` / `drawer-expand"`）でモーダルを開くと、メモ欄は
プレビューモードで開くのに、貼り付けた素のURL（`https://…`）がクリックできない。

### 原因
メモのプレビューHTMLを組み立てるコードが**ドロワー側と拡大モーダル側で二重に書かれていて、
モーダル側だけ素のURLをリンク化する `.replace()` が欠けていた**。
モーダル側は markdown 形式 `[表示名](URL)`（リンクボタンで挿入されるもの）しかリンク化しないため、
素のURLはただのテキストとして描画されていた。

- ドロワー側: `renderDtPreview()`（`renderDrawer()` 内）
- モーダル側: `renderDtPv()`（`reattachModalEvents()` 内）— こちらが欠落

### 対応
`_memoLinkify(escapedText)` を新設（`_cmLinkify` の直前）し、上記2ヶ所から呼ぶ形に一本化した。
今後どちらか一方だけ直して差分が出ることを防ぐ目的。同時に以下も直している。

- **クエリ付きURLが `&` の手前で切れる問題**：`esc()` を通した後なので `&` は `&amp;` になっている。
  素のURL用の文字クラスが `&` を除外していたため、`https://example.com/?a=1&b=2` が `?a=1` までしか
  リンクにならなかった。`(?:&amp;|[^\s<&"])+` に変更。`&amp;` は href 属性内でブラウザが `&` に
  戻すので、href をそのまま組み立てて問題ない（XSSエスケープは維持）。
- `rel="noopener"` を付与。

### 触っていない箇所
- ノート詳細（`nt-preview-area`）側のプレビュー生成は据え置き。こちらは元から素のURLをリンク化できて
  おり、下線スタイルがメモ側と異なるため統合すると見た目が変わる。
  なお `reattachModalEvents()` のノート側には `#nt-preview-btn` に対するプレビュー切替の実装が
  **2組（`ntPvBtn` ブロックと `mPvBtn` ブロック）重複して存在する**。初期状態が揃っているため
  実害は出ていないが、将来触るときは片方に寄せること。
- 認証・決済・DB（テーブル/RLS）には一切触れていない。フロントの表示処理のみの変更。

---

## Google Play公開に向けた課金導線の出し分け（A案：アプリ内課金導線なし）（2026-08-22）

### 背景・調査結果
「Google Playに公開した場合、今のStripeがそのまま使えるか」の調査。結論は以下。

- **Web版（app.taskra.jp）はStripeのまま一切変更不要。**
- Google Playの決済ポリシーが規制するのは「**アプリ内でデジタルコンテンツを購入させる**」行為。
  Taskraは生産性アプリのサブスクなので免除カテゴリ（物理商品・保険・1対1レッスン等）に該当しない。
- ただし「**他所で購入した権利をアプリ内で利用させるだけ**」（＝消費専用アプリ）はGoogleが公式に許容。
- 2025-12-18の**スマホ新法**（スマホソフトウェア競争促進法）全面施行で、日本ではアプリ内から
  外部決済へのリンクアウトも公式に可能になった。ただし**リンクを置くとGoogleへの手数料が発生する**
  （定期購入10% / 単発20%。リンククリック後**24時間**以内のWeb購入が手数料対象。日本での新手数料
  体系の適用開始は2026-09-30）。**リンクを張らないテキスト告知のみなら手数料0%。**

検討した3案：

| 案 | 内容 | Googleへの手数料 | 実装コスト |
|---|---|---|---|
| **A（採用）** | アプリ内に課金導線を置かない。Webで契約→アプリで利用 | **0%** | 小 |
| B | 外部リンクプログラムに登録しStripeへリンクアウト | 定期10% / 単発20% | 中 |
| C | Google Play Billingを併用（TWA + Digital Goods API） | 定期10% + 請求手数料5% | 大 |

C案は `user_plans` がemail主キー・Stripe前提のため、課金経路カラム追加＋RTDN(Real-time Developer
Notifications)→Pub/Sub→新Edge Functionでの解約・返金・猶予期間・アカウント保留のハンドリングが
必要で重い。まずA案、伸びたらB案、C案は最後。

### 実装（`index.html` のみ）

**1. Playアプリ（TWA）判定：`IS_PLAY_APP`（`PAYMENT_LINKS` の直後に定義）**

判定シグナルは2つ。どちらかがヒットすればPlayアプリ扱い。

1. `document.referrer === 'android-app://' + PLAY_APP_PACKAGE`（TWA起動時にChromeが付与）
2. 起動URLに `?src=twa`（BubblewrapのlaunchURLに設定しておく／保険）

**★ハマりどころ（実装中に踏んだ）**

| 罠 | なぜダメか | 対処 |
|---|---|---|
| `referrer.startsWith('android-app://')` で判定 | Chromeは**他のAndroidアプリ内リンクから開かれた場合も** `android-app://com.google.android.gm` 等を referrer に入れる。Gmail・LINE・Slackのリンクから来た**Web版ユーザーの購入ボタンが消える** | `PLAY_APP_PACKAGE`（`jp.taskra.app`）との**完全一致**で判定 |
| フラグを `localStorage` に保存 | TWAは同一端末のChromeブラウザと**同一オリジンのストレージを共有する**。TWAで立てたフラグがWeb版に残り、**Web版で購入できなくなる** | `sessionStorage` に保存（TWAセッションとブラウザタブは分離される） |
| `?src=twa` だけに依存 | 初期化コード（12300行台）が `history.replaceState` でURLパラメータを削除するため、**リロードで判定が消える** | sessionStorageで保持 |

- `PLAY_APP_PACKAGE='jp.taskra.app'` は **Play Consoleに登録するapplicationIdと必ず一致させること。**
  変えたらこの定数も変える（不一致だとTWA内で購入導線が表示され、ポリシー違反になる）。
- 誤検知で購入できなくなった場合の逃げ道：`?src=web` を付けて開く。解除はそのセッション中、
  referrerの再ヒットより優先される（sessionStorageに `'0'` を記録）。
- `window._isPlayApp` に判定結果を公開してある（Chrome DevToolsのリモートデバッグ用・参照専用）。

**2. 課金導線の出し分け（4ヶ所）**

| 箇所 | Web版 | Playアプリ内 |
|---|---|---|
| `showUpgradeModal()` スタンダード→プレミアム | 「アップグレード →」（Payment Link） | ボタンなし＋テキスト告知 |
| `showUpgradeModal()` フリー→2プラン選択 | 各カードに「選択する →」 | ボタンなし＋テキスト告知（**プラン比較の表示自体は残す**） |
| `openMyPlan()` プランカード | Payment Link / ポータル経由アップグレード | ボタンなし |
| `openMyPlan()`「プランの管理・解約はこちら →」 | Stripeカスタマーポータル | **非表示**＋テキスト告知 |
| ユーザーメニューのCTA | 「✦ アップグレード →」 | 「✦ プランを見る」 |

カスタマーポータルもPlayアプリ内では出さない。**ポータルからは上位プランへの変更＝購入ができる**ため。

**3. テキスト告知：`playBillingNoticeHtml()`**

> プランのお申し込み・変更・解約は、ブラウザで Taskra のWebサイト（app.taskra.jp）を開いて行えます。
> Webサイトでお申し込みいただいたプランは、同じGoogleアカウントでログインすればこのアプリでも
> そのままご利用いただけます。

**⚠️ ここに `<a>` やクリックで遷移する要素を足してはいけない。**「リンクを張らないテキスト告知」で
あることが手数料0%の条件。追加するとGoogleへの手数料（定期購入10%）が発生する。

**4. `.nojekyll` は今回入れていない（意図的に見送り）**

TWAをURLバーなしで全画面起動するにはDigital Asset Links検証が必要で、
`https://app.taskra.jp/.well-known/assetlinks.json` を配信しなければならない。
GitHub Pages（Jekyll）は `.` で始まるディレクトリを publish しないため `.nojekyll` が必要になるが、
**assetlinks.json 本体を置くまでは不要**で、Web版に対する変更を1バイトも入れない方針にしたため
今回は見送った。次に入れるときは assetlinks.json と同時に追加すること。

なお `.nojekyll` 追加時の安全性は事前確認済み：`grep -nE '\{[%{]' *.html` が
`index.html` / `devs.html` / `debug.html` / `test.html` / `id-check.html` すべてで**0件**
（＝Jekyllのテンプレート記法を含まない）。したがってJekyllを無効化しても配信されるHTMLは変わらない。

### ⚠️ HANDOVER.md / CLAUDE.md に書いてはいけない文字列（Pagesビルドが落ちる）

**このファイルは GitHub Pages の Jekyll が Liquid テンプレートとして処理する。**
`.md` 内にテンプレート記法の開き記号（波括弧2連、および波括弧＋パーセント）を生で書くと、
閉じ記号がないため **Pagesビルドがエラーで落ち、deployジョブがskipされて本番に反映されない。**

実際に 2026-08-22 の `653f8c1` で踏んだ（皮肉にも「Liquid構文は0件」と書いた文章自体が原因）：

```
Error: Liquid syntax error (line 86): Variable '...' was not properly terminated with regexp: /\}\}/
```

このとき本番は無傷（deployがskipされ旧版が配信され続けた）だが、変更は一切反映されなかった。

**書き方のルール**
- 説明で言及したいときは、生の2文字並びが現れない書き方にする。文字クラスを使った
  `\{[%{]` の形が安全。**バックスラッシュを挟むだけの書き方では漏れる**：
  波括弧をエスケープしてもバックスラッシュは波括弧の前に付くだけなので、
  直後にパーセントが続くパターンは生の2文字並びが残ってしまう（実際にこれで1回踏んだ）。
- コードブロック（``` で囲む）でも**回避できない**。LiquidはMarkdownより先に処理される。
  どうしても生で書く必要があれば `raw` / `endraw` タグで囲むか、`.nojekyll` を導入する。
- コミット前チェック：`grep -nE '\{[%{]' *.md` が0件であること。

将来 `.nojekyll` を入れればこの制約自体が消える（Jekyllが動かなくなるため）。
このリポジトリは `_config.yml` もレイアウトも持たず、Jekyllは `.md` をテーマHTMLに変換している
だけで誰も見ていないので、`.nojekyll` 導入はこの地雷を恒久的に取り除く意味でも合理的。

### 動作確認（Playwright + Chromium、iPhone相当のモバイルエミュレーション、33項目すべてパス）

`document.referrer` を `Object.defineProperty` で偽装してTWA起動を再現。

| ケース | 結果 |
|---|---|
| Web版 free：購入リンク2本が出る / 告知は出ない | ✅ |
| Web版 premium：解約ポータルボタンあり | ✅ |
| Web版 standard：アップグレードリンク1本＋ポータル経由アップグレードあり | ✅ |
| TWA(`?src=twa`) free：購入リンク0本・**overlay内の`<a href>`が0個**・告知あり | ✅ |
| TWA free：localStorageを汚さない（`null`）/ sessionStorageに保持（`'1'`） | ✅ |
| TWA free：**リロード後も判定維持**（URLからパラメータが消えても） | ✅ |
| TWA(referrer) premium：解約ポータルボタンなし・購入リンク0本・告知あり | ✅ |
| TWA standard：アップグレードリンク0本・ポータル経由アップグレードなし | ✅ |
| **誤検知なし**：`android-app://com.google.android.gm` / `jp.naver.line.android` / `com.Slack` → いずれも判定false・購入リンク2本 | ✅ |
| 自パッケージ `android-app://jp.taskra.app/`（末尾スラッシュ）→ true | ✅ |
| `?src=web` で解除、セッション中はreferrer再ヒットより優先 | ✅ |
| JSエラー | 0件 |

inline script 3ブロックすべて `node --check` 通過。

### Web版に一切影響しないことの検証（回帰テスト）

「これまでのWeb版の機能には一切影響しないように」という要件に対し、
**旧版（HEAD~1）と新版のHTML出力をバイト単位で全比較**した。

**1. 生成HTMLの全比較 — 40種類すべて完全一致（差分0件）**

旧版 `index.html` と新版を同一オリジンに並べて配信し、Web版の条件（`?src=`なし・
referrer偽装なし）で以下が生成するHTMLを文字列比較した。

| 対象 | 組み合わせ | 結果 |
|---|---|---|
| `showUpgradeModal()` | 3プラン × 11 featureキー（`tasks`/`banner`/`projects`/`notes`/`ai`/`fileExtract`/`team`/`repeat`/`gantt`/`attachments`＋未知キー） | 33種すべて一致 |
| `openMyPlan()` | 3プラン | 3種すべて一致 |
| `showUserMenu()` | 3プラン | 3種すべて一致 |
| localStorage / sessionStorage のキー一覧 | — | 旧版・新版ともに空（`{ls:[],ss:[]}`） |

旧版・新版ともJSエラー0件。**新版はWeb版でストレージへの書き込みを一切行わない**
（`IS_PLAY_APP` の判定ロジックは、Web版では `read()` しか通らず `write()` に到達しない）。

**2. Web版の実利用条件で誤検知しないこと — 11ケースすべてパス**

すべて「判定=false・購入リンク2本・ストレージ書き込み0・JSエラー0」を期待値として確認。

| ケース | 結果 |
|---|---|
| 通常のPC Chrome | OK |
| **PWA standalone（ホーム画面から起動）** ※普段の使い方 | OK |
| iPhone Safari UA / Android Chrome UA | OK |
| referrer = google.com / 同一オリジン / 空 | OK |
| 他アプリのreferrer（Gmail / LINE） | OK |
| 無関係なクエリ付き（`?view=today&task=abc123`） | OK |
| 未知の `?src=newsletter` | OK |

判定ロジックは `display-mode: standalone` や `navigator.standalone` を**見ていない**ため、
ブラウザからホーム画面に追加したPWAは影響を受けない（TaskraはPWAとして使われているので重要）。

**3. 追加した識別子の衝突なし**

`PLAY_APP_PACKAGE` / `PLAY_APP_FLAG` / `IS_PLAY_APP` / `playBillingNoticeHtml` /
`window._isPlayApp` / sessionStorageキー `taskra_src_twa` は、いずれも既存コードに
同名の識別子が存在しないことを確認済み。`?src=` パラメータも既存機能では未使用。

### セキュリティ関連の状態
- **新規/変更したテーブル：なし。** マイグレーション追加なし。RLSの状態に変更なし
  （`user_plans` はRLS有効・ポリシー3件のまま）。
- **認証フローの変更：なし。**
- **決済フローの変更：サーバー側は一切なし。** `stripe-webhook` / `stripe-portal` Edge Function、
  Stripe Price ID、Payment Link URLは未変更。変更したのは**フロントエンドの導線表示のみ**。
- 権限判定は従来どおり `user_plans` を正とするサーバー側（RLS）で、今回の出し分けは**UI表示のみ**。
  仮にPlayアプリ内で判定を回避してPayment Linkを開いたとしても、購入・権限付与の経路は変わらない。
- 触っていない箇所：`supabase/` 配下すべて、`src/`、`sw.js`、管理者向け `openPlanAdmin()`。
- diffに秘匿情報（APIキー・トークン・パスワード）が含まれないことを確認済み。

### 次にやるべきこと

**TWAのパッケージング（未着手・リポジトリ外の作業）**
1. `npx @bubblewrap/cli init --manifest https://app.taskra.jp/manifest.json`
2. applicationId を **`jp.taskra.app`** にする（`index.html` の `PLAY_APP_PACKAGE` と一致必須）
3. launch URL に **`?src=twa`** を付ける（referrer判定のフォールバック）
4. `bubblewrap build` で生成した署名鍵のSHA-256フィンガープリントを取得し、
   **`.nojekyll` と `.well-known/assetlinks.json` をセットで**このリポジトリに追加してpush
   （`.nojekyll` がないとGitHub Pagesが `.well-known/` を配信しない）：
   ```json
   [{"relation":["delegate_permission/common.handle_all_urls"],
     "target":{"namespace":"android_app","package_name":"jp.taskra.app",
               "sha256_cert_fingerprints":["<署名鍵のSHA-256>"]}}]
   ```
   ※Play Console の「アプリ署名」でGoogleが再署名するので、**Play Consoleに表示される
   アプリ署名鍵のフィンガープリント**を使うこと（ローカルのupload鍵ではない）
5. Play Console でデータセーフティ・プライバシーポリシー・料金体系の申告
   （「アプリ内購入なし」で申告する。Webで課金することは申告フォームの対象外）

**実機確認**
- TWAで起動して `window._isPlayApp === true` になるか（Chrome DevToolsのリモートデバッグ）
- アップグレードモーダル・マイプランに購入ボタンが出ないこと
- **同じ端末のChromeブラウザで app.taskra.jp を開いたとき、購入ボタンが出ること**（最重要の回帰確認）
- Web版で契約したプレミアムがTWA側に反映されること

**別途対応が必要（今回のスコープ外・前回調査で見つけた懸念）**
- `PAYMENT_LINKS` のコメントが「テスト用。本番切り替え時はURLを差し替え」のまま（`index.html:1421` 付近）。
  URLは `buy.stripe.com/test_...` ではないので本番リンクに見えるが、コメントが実態と乖離している。要確認。
- `loadUserPlan()` はログイン時にしか走らないため、決済完了後にアプリへ戻ってもプランが即時反映されない
  可能性がある。A案ではアプリ内で買わないので優先度は下がるが、Web版では体感に影響する。
  `visibilitychange` での再取得を検討。

---

## Nextビューのフィルタ既定値を「現在ON / 共有OFF」にする（2026-08-21）

### 要件
Nextビュー（各PJの次のアクション一覧）を開いた時点で、フィルタの既定を
「現在」ON（開始日が未来のタスクを除外）・「共有」OFF（共有プロジェクトを除外）にする。

### 実装（index.html のみ）
フィルタ状態 `S.hideNotStarted` / `S.showShared` は全ビュー共通のグローバル状態なので、
ビュー切替を1ヶ所で捕まえる `applyViewFilterDefaults(v)` を追加した（`renderContent()` の直前に定義）。

- 直前に描画したビューを `_vfLastView` で保持し、**ビューが変わった瞬間のみ**適用する。
  そのためNextビュー内でユーザーが「現在」「共有」を手動トグルしても、再レンダーで上書きされない。
- Nextに入るときに入る直前の値を `_vfSavedFilter` へ退避し、Nextから離れたときに復元する。
  （Nextを見ただけでToday等のフィルタが変わる副作用を避けるため）
- 呼び出しは `render()` 先頭（サイドバーのバッジ計算より前）と `renderContent()` 先頭の2ヶ所。
  サイドバーやボトムナビ、スワイプ切替、リロード時の `focus_view_state` 復元も
  最終的にこのどちらかを通るため、ビューへの入口ごとに個別対応は不要。

### 動作確認
ローカル（`python -m http.server 8765`）で読み込み、ページコンテキストで状態遷移を検証。
- 初期 `{現在:false, 共有:true}` → Today: 変化なし → Next: `{true,false}`
- Nextで再度呼んでも `{true,false}` のまま（再レンダーで手動トグルを潰さない）
- Nextで共有を手動ONにした後も再レンダーで維持 → Inboxへ移動で `{false,true}` に復元
コンソールエラーなし。inline script 3ブロックすべて `node --check` 通過。

### セキュリティ関連の状態
UI表示フィルタのみの変更。テーブル・RLS・認証・決済フローには一切触れていない。
新規テーブルなし、マイグレーションなし、Edge Function変更なし。

### 次にやるべきこと
- 実機（iPad/スマホ）でNextを開いて既定が効いているか確認する。
- フィルタ状態をビュー別に持つ設計は入れていない。将来ビュー別に既定を増やすなら
  `applyViewFilterDefaults` を拡張するか、`S.filterByView` のような構造への移行を検討する。

---

## スマホでタスク詳細の入力欄がキーボードに隠れる問題の修正（2026-08-17）

### 症状
スマホ（iOS）でタスク詳細を開き、**コメント欄・日時（期限/開始日/開始時間）・メモ欄**をタップすると、
キーボードがせり上がった瞬間に入力欄がキーボードの裏へ入ってしまい、何を打っているか見えない。
慎重にスワイプすると入力欄までたどり着けるが、下部アクションバー（完了 / ••• / ×）が
キーボードと一緒にせり上がって居座るため、ただでさえ狭い可視領域をさらに削っていた。

### 原因（直近の改修 `b5762d9` の副作用）
`b5762d9`「iPadでコメント入力欄が画面最上部へ飛ぶ問題を修正」で、

1. `--app-h`（= `visualViewport.height`）でシェル高を可視領域に合わせる
2. コメント入力欄を `.cm-composer` の `position:sticky` で下端固定

を導入し、**フォーカス時のスクロール補正を全廃**した。iPadの暴走は止まったが、スマホでは足りなかった。

- `--app-h` で**シェル（外枠）は縮む**が、**スクロールコンテナの中身の位置は動かない**。
  つまりキーボード出現前に見えていた入力欄は、縮んだ分そのまま下へはみ出して隠れる。
  スマホは可視領域が300px前後しか残らないため、はみ出し量が大きく実害になった。
- `sticky` が効くのは**コメント入力欄だけ**。しかもコメントセクション自体が可視領域より
  下へ出てしまえば止まらない。**日時・メモにはそもそも効かない**。
- 下部アクションバーはシェル内の `flex-shrink:0` 要素なので、シェルが縮んでも高さを維持し、
  キーボードのすぐ上に残り続ける（＝入力欄に使える高さをさらに50px以上奪う）。

### 対処（index.html のみ）

**1. スクロール補正を「最小構成で」復活（JS: `--app-h` の対策IIFE内）**

`ensureFocusedVisible()` を追加。旧実装（480pxスペーサー＋150/350/600msタイマー連打）が
暴走した要因は取り除いてある。

| 旧実装（暴走した） | 今回 |
|---|---|
| コンテナ末尾に480pxスペーサーを挿入 | **挿入しない**（押せる余白を無限供給しない） |
| スクロール量の上限なし | **実際のスクロール可能範囲でクランプ** |
| レイアウトVP基準のrectとvisualViewport座標を混在 | `--app-h`＋`resetOuterScroll()` で両者が一致するため `getBoundingClientRect` だけで判定 |
| 固定タイマー3連打 | `visualViewport.resize` + `focusin`（rAF＋300ms×1回） |

- スクロールコンテナはクラス名の列挙ではなく `overflowY` の計算済みスタイルから探索
  （`scrollParent()`）。拡大モーダル等も自動で対象になる。
- 背の高い textarea（メモ）で上端が画面外へ抜けないよう、下スクロール量に上限を設けている。
- `focusin` 側の300ms遅延は、**キーボードが出たまま別の入力欄へ移った場合**に
  `visualViewport` の `resize` が発生しない経路をカバーするためのもの。

**2. キーボード表示中は `<html>` に `kb-open` を付与し、省スペース化（CSS: `@media(max-width:768px)` 内）**

```css
html.kb-open .mob-action-bar{display:none}                     /* 完了/•••/× を一時退避 */
html.kb-open #dt-notes,html.kb-open #nt-body{max-height:calc(var(--app-h,100dvh) * .5)}
```

- アクションバーは入力中に使うボタンではないため、キーボードが出ている間だけ隠す（閉じれば即復帰）。
  完了ボタンを押したいときは、いったんキーボードを閉じれば元に戻る。
- `rows=12`(`#dt-notes`) / `rows=6`(`#nt-body`) のメモ用textareaは、そのままだと
  縮んだ可視領域を1つで食い尽くすため、キーボード表示中だけ可視領域の半分を上限にする。

### 動作確認（Playwright + Chromium、iPhone 13相当のモバイルエミュレーション）
iOS Safari の挙動（**キーボードが出ても `innerHeight` は縮まず `visualViewport` だけ縮む**）を
`visualViewport.height` の上書き＋`resize` 発火で再現して検証した。キーボード高336px想定、可視領域328px。

| ケース | 修正前 | 修正後 |
|---|---|---|
| コメント入力欄をタップ | 下端484px（可視328px）→ **隠れる** | 下端320px → **見える** |
| 期限（日付）をタップ | 下端355px → **隠れる** | 下端320px → **見える** |
| メモ欄をタップ | 下端488px → **隠れる** | 下端320px・上端156px（全体が収まる） → **見える** |
| キーボード表示中に別の入力欄へ移動（title/期限/開始時間/サブタスク/コメント） | － | 5項目すべて可視 |
| NOTE詳細（`#nt-body` / `#ncm-input`） | － | いずれも可視 |
| キーボード表示中に `resize` を12連打 | － | `scrollTop` が 1642 から動かない（**暴走なし**） |
| キーボードを閉じる | － | `--app-h` 解除・`kb-open` 解除・アクションバー復帰 |
| PC幅（1280px） | － | `kb-open` 付かず・`--app-h` 未設定・レイアウト変化なし |
| コンソールエラー | 0件 | 0件 |

### セキュリティ影響
**なし。** 今回の変更は CSS とビューポート追従のUIロジックのみ。

- 新規/変更したテーブル：**なし**（マイグレーション追加なし。RLSの状態にも変更なし）
- 認証フローの変更：**なし**
- 決済フロー（Stripe Webhook / Edge Function / 料金プラン）の変更：**なし**
- 触っていない箇所：`supabase/`配下すべて、`src/secret-memo.js`、`sw.js`
- diffに秘匿情報（APIキー・トークン・パスワード）が含まれないことを確認済み

### 次にやるべきこと / 注意点
- 実機（iPhone・iPad両方）で、コメント／日時／メモ／サブタスク追加の各入力を確認する。
  特に**iPadで `b5762d9` が直した「入力欄が右上最上部へ飛ぶ」現象が再発していないか**は要確認
  （今回スクロール補正を復活させているため、ここが唯一の回帰リスク）。
  再発した場合は `ensureFocusedVisible()` のクランプ（`lo`/`hi`）が効いているかを
  Chromeのリモートデバッグで `box.scrollTop` の推移を見て切り分けること。
- キーボード表示中にアクションバーが消える挙動は意図的。ユーザーから「完了ボタンが消える」と
  指摘が来たら、`display:none` ではなく高さを詰めた簡易バー化も選択肢。
- `d1b2ebb`（電卓削除）の取りこぼし（孤立`</div>`・未使用CSS）は未対処のまま。下記参照。

---

## フォルダパスをタップしたとき、コピーと同時に編集モードへ入ってしまう問題の修正（2026-08-17）

### 症状
タスク詳細メモ／NOTE本文に `C:\Users\...\Yext契約更新20260731` のようなフォルダパスを1行で書くと、
プレビュー表示で「📁 パス」チップ（`.note-path-chip`）になり、タップでクリップボードにコピーできる。
ところが**コピーと同時にプレビューが解除されて編集モードに入り、textareaにフォーカスが移る**
（スマホではキーボードまでせり上がる）。コピーしたいだけなのに毎回編集状態を閉じる手間が発生していた。

### 原因
チップはプレビュー領域（`#dt-preview-area` / `#nt-preview-area`）の**内側**にあり、
プレビュー領域側に「タップで編集モードへ」というハンドラが別途付いている。

| 場所 | ハンドラ | 内容 |
|---|---|---|
| index.html:7088 付近 | `dtPreviewArea` の `click` | シングルタップで `dtExitPreview()` |
| index.html:6401 付近 | `ntPreviewArea` の `touchstart` | 600ms長押しで `ntExitPreview()` |
| index.html:9849 付近 | 拡大モーダルの `dtPvArea` `touchstart` | 同上 |
| index.html:9911 付近 | 拡大モーダルの `ntPvArea` `touchstart` | 同上 |

チップ側の処理（`data-a="open-folder-path"`、index.html:8353 付近）は**document への委譲リスナー**で、
`e.stopPropagation()` を呼んでいるが、バブリングの順序上プレビュー領域のリスナーの方が先に走るため
編集モードへの切り替えを止められていなかった。旧コードの除外条件は `e.target.tagName==='A'` のみで、
チップ（`<button>`）は対象外だった。

### 対処（index.html のみ）
判定ヘルパーを1つ追加し、プレビュー領域側の4つのハンドラで共通に除外する。

```js
// index.html:7243 付近
function _isCopyOnlyTarget(t){
  if(!t||!t.closest)return false;
  return !!t.closest('.note-path-chip,a');
}
```

- `dtPreviewArea` の click：`if(_isCopyOnlyTarget(e.target))return;`（リンクの除外もこれに統合）
- 長押し3か所の `touchstart` 冒頭：同じガードで早期 return（タイマーを張らない）

チップ以外のプレビュー領域をタップ／長押ししたときの「編集モードへ入る」挙動は従来どおり。

### 動作確認（ローカル 127.0.0.1:8791、Service Worker/Cache 破棄後）
| ケース | 修正前 | 修正後 |
|---|---|---|
| タスク詳細プレビューでチップをタップ | プレビュー解除＋`#dt-notes`にフォーカス | プレビュー維持・コピーtoastのみ |
| NOTEプレビューでチップをタップ／長押し | （長押しで編集へ） | プレビュー維持・コピーtoastのみ |
| 拡大モーダル（最大化）でチップをタップ／長押し | 同上 | プレビュー維持・コピーtoastのみ |
| チップ以外のプレビュー領域をタップ／長押し | 編集モードへ | 編集モードへ（変更なし） |

### セキュリティ影響
なし。DBスキーマ・RLS・認証・決済いずれにも変更なし（UIイベントの分岐のみ）。

### 関連して修正した既存バグ
下の「拡大モーダルの `_syncExpandWithCalc` ReferenceError」を参照（同日中に対処済み）。

---

## 拡大モーダルで `_syncExpandWithCalc is not defined` が出る問題の修正（2026-08-17）

### 症状
「最大化」ボタンでタスク／NOTEの拡大モーダルを開くたびに、コンソールに
`ReferenceError: _syncExpandWithCalc is not defined`（index.html:9745）が出ていた。

### 原因
`_syncExpandWithCalc()` は **電卓ドロワーと拡大モーダルの同時表示を調整する関数**として
`faa2e60`（2026-05-05「PC: 電卓ドロワーとexpandモーダルの同時表示に対応」）で追加されたもの。
その後 `d1b2ebb`「feat: 電卓機能を完全削除」で**定義側だけが削除され、
`openExpandModal()` 内の呼び出し2箇所が消し忘れられていた**。

実害は限定的だった（モーダル生成とイベント再アタッチは例外発生前の `renderInto()` で完了済み。
失われるのは電卓連動の後始末だけで、電卓自体がもう存在しないため無意味）が、
例外で毎回コンソールが汚れ、後続のデバッグを妨げるため対処。

### 対処（index.html:9745）
呼び出しと、それを再実行するためだけの MutationObserver をまとめて削除（電卓連動専用のため復元不要）。

```js
  // 削除前
  _syncExpandWithCalc();
  const _syncObs=new MutationObserver(()=>{if(!document.contains(ov)){_syncObs.disconnect();_syncExpandWithCalc();}});
  _syncObs.observe(document.body,{childList:true});
```

### 動作確認（ローカル、SW/Cache破棄後）
- 拡大モーダルを開く：例外なし・`window.onerror` も0件
- モーダル内のメモプレビュー・フォルダパスチップのタップ（コピーのみ）：正常
- モーダル内でタイトル編集 → `S.tasks` に反映される（`reattachModalEvents` は生きている）
- Escキー／オーバーレイクリックで閉じる：どちらも正常

### 残っている電卓機能の残骸（未対処・別件）
`d1b2ebb` の取りこぼしが index.html にまだある。いずれもJSからの参照はなく無害だが、掃除候補：
- 1188〜1192行：`<!-- Calculator drawer -->` 配下の**孤立した `</div>` 2つ**と
  `#calc-head-tonote-btn` ボタン、`#calc-drawer-body` の空div（開始タグ側は削除済みで構造が壊れている）
- CSS：`.calc-topbar-btn` / `.calc-top-scroll` / `.calc-mid-section` / `.calc-label-*` など（238〜309行付近）

---

## iPadでタスクのワンタップが効かず2タップ必要だった問題の修正（2026-08-16）

### 症状
iPad（PWA横向き）でタスク行をワンタップしても、行の右側に「最大化（⤢）」ボタンが現れるだけで、
右ペインのタスク詳細がタップしたタスクに切り替わらない。もう一度タップすると切り替わる。
つまり毎回2タップを強いられていた。

### 原因
**iPadOS Safari の「1回目のタップ＝ホバー」判定**に、行のホバー表示ボタンが引っかかっていた。

WebKit は、タップされた要素がホバースタイルによって見た目を変える場合、
1回目のタップを「ホバーを当てる」だけで消費し `click` を発火させない（2回目で発火）。
これは「hover でメニューが出るサイトをタッチでも使えるようにする」ための昔からの互換挙動。

Taskra は幅769px以上でPCレイアウト分岐に入る設計のため、iPad（横1194px等）はPC扱いになり、
以下の**ホバーで見た目が変わるルールが `.trow`（タスク行）に効いていた**：

| 場所 | ルール | pointer:fine ガード |
|---|---|---|
| index.html:155 | `.trow:hover{background;border-color}` | あり（対策済みだった） |
| index.html:642 | `.trow:hover .trow-expand-btn{opacity:1}` | **なし ← 主犯** |
| index.html:649 | `.trow:hover .trow-copy-btn{opacity:1}` | **なし** |
| index.html:784 | `.trow:hover .task-drag-handle{opacity:.45}` | **なし** |

行の背景色だけは既に `@media(pointer:fine)` で隔離済みだったが、
ボタンの出現（opacity 0→1）が隔離されていなかったため、そこで判定に引っかかっていた。
スクリーンショットで「タップすると最大化ボタンだけが出る」のは、まさにこのホバー適用の瞬間。

JS側（`data-a="sel"` ハンドラ、index.html:8493〜）には問題なし。`click` が来れば正しく詳細を切り替える。

### 対処（index.html のみ・CSSのみ）
**方針：ホバーで出す挙動は `pointer:fine`（マウス/トラックパッド）限定にし、
`pointer:coarse`（タッチ）ではホバーに依存せず常時薄く表示する。**
既存の `.trow:hover` / `.chk:hover` が `@media(pointer:fine)` で書かれているのと同じ流儀に揃えた。

1. `.trow-expand-btn` / `.trow-copy-btn`（index.html:641〜）
   - `@media(min-width:769px)` の中を `pointer:fine` と `pointer:coarse` に分岐。
   - fine：従来どおり `opacity:0` →ホバーで `1`。
   - coarse：`opacity:.45` で常時表示＋`:active` でフィードバック。`touch-action:manipulation` と
     `-webkit-tap-highlight-color` も付与。
2. `.task-drag-handle`（index.html:806）
   - `.trow:hover .task-drag-handle{opacity:.45}` を `@media(pointer:fine)` で囲んだ。
     タッチ環境では既存の `@media(hover:none),(pointer:coarse){opacity:.25}` が常時効くので見た目は維持。
3. サイドバーの `.proj-item` / `.tag-item`（index.html:567〜）※同種の欠陥の横展開
   - `:hover .proj-actions{display:flex}` も同じ理由でiPadのプロジェクト切り替えが2タップになっていた。
     `pointer:fine` 限定にし、`pointer:coarse` では常時 `display:flex`（スマホと同じ扱い）に。

**この「ホバーで要素を出す」書き方は、今後 `pointer:fine` ガードなしで足すと同じ2タップ問題が再発する。**
行やリスト項目など「タップして選ぶもの」の中にホバー表示要素を置くときは必ずガードすること。

### 検証
Chromium(Playwright) で `index.html` を実ロードし、行のマークアップを挿入して計測（全PASS）。
- **iPad相当（1194×834 / hasTouch=true → pointer:coarse）**：
  ホバー前後で行の背景色・ボーダー色・展開ボタン・コピーボタン・ドラッグハンドルの
  computed style が**一切変化しない**ことをアサート。
  かつ展開ボタンが `opacity:.45 / display:flex` でホバーなしに見えていることを確認。
- **デスクトップ回帰（1440×900 / hasTouch=false → pointer:fine）**：
  非ホバー時 `opacity:0` →ホバーで `1`、行背景が変化、ハンドルが `0→.45` と、従来挙動を維持。
- サイドバーも同様に、iPadで常時 `display:flex` / PCで `none→flex` を確認。
- JSエラーゼロ。
- **未検証：実機iPadOS Safari/PWA。** Chromium は WebKit のこのタップ判定自体を再現できないため、
  「ホバーで見た目が変わらなくなったこと」を代理指標として検証している。実機での最終確認が必要。

### セキュリティ関連の状態
- **本変更は認証・決済・個人情報のいずれにも該当しない**（`index.html` のCSSのみ、JS・HTML構造の変更なし）。
- 新規/変更したテーブル：**なし**。RLSポリシーの変更：**なし**。マイグレーション追加：**なし**。
- 認証フロー（Google OAuth）・決済フロー（Stripe Webhook・Edge Function・`user_plans`）ともに変更なし。
- 触っていない箇所：`supabase/` 配下すべて、`sw.js`、`manifest.json`、Edge Function 群、
  および `index.html` 内のJavaScript全域。
- 秘匿情報の混入なし（diffはCSSブロックとコメントのみ）。

### 次にやるべきこと
- 実機iPadでワンタップ切り替えを確認。まだ2タップなら、他にホバーで見た目が変わる要素が
  行の中に残っていないかを疑う（`grep -n "hover" index.html | grep -E "trow|ttitle|tmeta|\.mc"`）。
- 未対処で残した同種のルール：`.cm-item:hover .cm-del{opacity:1}`（index.html:1004 付近）。
  コメント自体はタップ対象ではないので実害は出ていないが、コメントにタップ操作を足すなら要ガード。
- タッチiPadで展開/コピーボタンが常時見えるようになったため、行の右端をタップしたときの
  誤タップ感がないか実機で確認してほしい（濃度 `.45` は調整可能）。

---

## iPadでコメント入力欄が画面最上部へ飛ぶ問題の修正（2026-08-16）

### 症状
iPad（PWA全画面・横向き）でタスク詳細のコメント入力欄にカーソルを置いた瞬間、入力欄が画面右上の最上部へ移動し、ドロワーのヘッダも周囲のコメントも消えて巨大な空白だけが残る。iPhoneでは再現しない。

### 原因（3つの複合）
1. **シェルが高さ固定・スクロール不可の設計**
   `.layout{height:100dvh;overflow:hidden}` で、スクロールを担うのは `.drawer-body` など内部要素のみ。window/body のスクロール位置は常に0であるべき構造。
2. **iPadOSはキーボードでレイアウトビューポートを縮めない**
   `window.innerHeight` も `100dvh` も変化せず（`dvh` は仕様上キーボードを勘定に入れない）、変わるのは `visualViewport.height` / `offsetTop` だけ。アプリは「まだ画面いっぱい使える」と思ったまま可視領域だけが縮み、WebKit がキャレットを見せようとページ全体を上へずらす → ドロワーのヘッダごと画面外へ。
   iPhoneで再現しないのは、幅769px以上でPCレイアウト分岐に入る（ドロワーが `position:fixed` 全画面ではなく `.layout` のフレックス子になる）経路をiPhoneが通らないため。フローティング/最小化キーボードを持つのもiPadだけ。
3. **スクロール補正が4か所で競合**
   グローバル `focusin`（480pxスペーサー＋150/350/600msタイマー）／`visualViewport.resize`／`_cmSetupInput` の `onfocus`／`scroll-to-comments` が同じ「入力欄を見せる」処理を各自実行。しかも `getBoundingClientRect()`（レイアウトビューポート基準）と `visualViewport`（ビジュアルビューポート基準）で座標系が食い違うため、ページがずれた状態では「まだ隠れている」と誤判定して押し続け、480pxスペーサーが常に押せる余白を供給するせいで止まらなかった。キャプチャの巨大な空白はこのスペーサーそのもの。

### 対処（index.html のみ・4点）
1. **コメント入力欄一式を `.cm-composer` で包み `position:sticky; bottom` 固定**（CSS `.cm-composer`）
   会話UIの定石どおり入力欄を本文と一緒にスクロールさせない。これで「フォーカス時に入力欄まで自動スクロールする」処理自体が不要になり、暴走の起点が消える。タスク詳細（`#cm-input`）とノート（`#ncm-input`）の両方に適用。
   - `position:sticky` は `overflow:hidden` な祖先があると無効化されるため `#cm-section{overflow:visible}` で解除し、クリッピングで担っていた角丸は `.dt-section-head` 側に明示指定して見た目を維持。
   - sticky の停止位置がスクロールコンテナの内容ボックス下端になる都合で、`.drawer-body` の下パディング(14px)分だけ背後のコメントが覗く。`bottom` を負に振り `padding-bottom` で戻す（CSS変数 `--cm-composer-bleed`）ことで塞いだ。
2. **CSS変数 `--app-h` でシェルの高さを `visualViewport` に従属させる**
   キーボード表示中だけ JS が `--app-h: <visualViewport.height>px` を `:root` に設定し、`body` / `.layout` / `.main` / `.drawer` / `.expand-overlay` がそれに追従する。最初からキーボードの上に正しく収まるので、WebKit がページをずらす動機自体がなくなる。
   - `@supports (height:100dvh)` で囲ってある。dvh未対応ブラウザで `var(--app-h,100dvh)` のフォールバック値が invalid になり `height:auto` へ落ちるのを防ぐため。**この @supports は外さないこと。**
   - キーボード判定は `window.innerHeight - visualViewport.height > 90`（`KB_MIN`）かつ入力欄フォーカス中。ピンチズームでの誤作動を避けるためフォーカス条件は必須。
3. **旧補正の撤去**：480pxスペーサー、150/350/600msタイマー、`adjustScroll`、`_cmSetupInput`/`_ncmSetupInput` の `onfocus`、`scroll-to-comments` の入れ子スクロール補正をすべて削除。`resetOuterScroll()`（window/bodyのスクロールを0へ戻す保険。外部キーボード接続時にも効く）だけ新ブロックへ統合して残した。
4. `focus({preventScroll:true})` に統一。

正味 +116 / −137 行でコード量は減っている。

### 検証
- Chromium(Playwright, iPad Pro 11" 相当 1194×834)で `.cm-composer` の `position:sticky` 実効、`#cm-section` の `overflow:visible`、ヘッダ角丸7pxの維持を確認。
- スクロール位置（先頭／途中／コメント中盤／最下部）と `--app-h=420px`（キーボード表示相当）の全条件で、**入力欄が常に可視**かつ **composerの下にコメントが透けない**ことをアサーション付きで確認（全PASS）。
- 本体 `index.html` をブラウザで実ロードし、アプリ由来のJSエラーがゼロであること、デスクトップ（キーボードなし）では `--app-h` が未設定のまま `.layout` が従来どおり全画面高になる（回帰なし）ことを確認。
- **未検証：実機iPadOS Safari/PWA。** Chromium は iPadOS のキーボード挙動を再現できないため、実機での最終確認が必要。特に「フローティング/最小化キーボード」と「Split View / Stage Manager」時の `KB_MIN=90` の妥当性は実機で見てほしい。

### セキュリティ関連の状態
- **本変更は認証・決済・個人情報のいずれにも該当しない**（CSS と描画/イベント処理のみ、`index.html` 単一ファイル）。
- 新規/変更したテーブル：**なし**。RLSポリシーの変更：**なし**。マイグレーション追加：**なし**。
- 認証フロー（Google OAuth・`email/profile` スコープ）変更なし。決済フロー（Stripe Webhook・Edge Function・`user_plans`）変更なし。
- 触っていない箇所：`supabase/` 配下すべて、`sw.js`、`manifest.json`、Edge Function 群。
- 秘匿情報の混入なし（diffは `index.html` の CSS/HTML/JS のみ）。

### 次にやるべきこと
- 実機iPadで再現確認。直っていない場合、まず `document.documentElement.style.getPropertyValue('--app-h')` がフォーカス時に入るかを見る（入らなければ `KB_MIN` の閾値、入るのにズレるなら WebKit 側のページシフトが残っている）。
- 同種の「フォーカス時に隠れる入力欄」は他にもある（`#sub-inp`、`#dt-notes`、AIパネルの `#ai-input-wrap`）。`--app-h` で改善するはずだが、必要なら同じ sticky 化を検討。
- `#ai-panel{height:75vh}` は `--app-h` 未対応のまま。キーボードとの相性を実機で確認のこと。

---

## 画像・ファイル添付機能（タスク詳細 / ノート）（2026-08-09）

### 背景・方針決定
「タスク詳細とノートに画像・ファイルを添付したい。ただしTaskra側に保存せずユーザーのGoogleアカウント（Drive）に保存したい（自社負担を減らす目的）」という要望から出発。
プロダクトデザイナー観点で前提を検証した結果、**Google Drive保存は不採用**とした（理由：現ログインは `email/profile` スコープのみで Drive書込には追加OAuth同意＋provider tokenのサーバー保持基盤が新規に必要／共有ワークスペースで他メンバーにファイルが見えず破綻／Drive側削除でリンクが即壊れる／節約できるストレージ費用に対し恒久的な複雑さとUX劣化が大きい）。
ユーザー合意のうえで **保存先 = Supabase Storage（private バケット）／添付は共有ワークスペースで他メンバーにも共有する** 方針に決定。

### 実装内容
**DB（マイグレーション `supabase/migrations/20260810_attachments.sql`／ライブ適用済み）**
- 新規テーブル `attachments`（`id` text PK / `task_id` text FK→tasks(id) ON DELETE CASCADE / `note_id` text FK→notes(id) ON DELETE CASCADE / `user_id` uuid=auth.uid() / `file_name` / `mime_type` / `size_bytes` / `storage_path` unique / `kind` 'image'|'file' / `width` / `height` / `created_at`）。`task_id`・`note_id` は XOR 制約（`num_nonnulls(task_id,note_id)=1`）で必ず片方のみ紐付く。
- Storage private バケット `attachments`（`public=false` / `file_size_limit=25MB` / 画像・PDF・Office・txt/csv/zip の MIME 許可リスト）。パス命名規約 `{user_id}/{attachment_id}/{filename}`。
- 権限：`anon` は全権 REVOKE、`authenticated`/`service_role` のみ GRANT。

**RLS（既存 tasks/notes の可視性ルールを厳密にミラー）**
- `attachments` 4ポリシー：
  - SELECT = 自分の添付 OR 共有プロジェクト配下タスクの添付（`task_id IN (…workspace_id IN (select auth_user_workspace_ids()))`）。
  - INSERT = `user_id=auth.uid()` かつ 対象が「自分のノート」or「自分の/共有タスク」。
  - UPDATE = 自分のみ。DELETE = 自分 OR 共有タスクのワークスペース owner。
- `storage.objects` 3ポリシー（バケット `attachments` 限定）：
  - INSERT = `(storage.foldername(name))[1] = auth.uid()::text`（自分の枠にのみ書ける）。
  - SELECT/DELETE = 自分の枠 OR `exists(select 1 from attachments a where a.storage_path=name …)`。**このサブクエリが `attachments` の RLS を受けるため、共有可視性を storage 側に再実装せず attachments に委譲**している。→ **`attachments` 側ポリシーと storage 側は常にセットで変更すること**（片方を緩めると storage 可視性も連動する）。

**仕様上の非対称（重要）**
- **タスク添付＝共有対象**（共有プロジェクト配下なら他メンバーも閲覧・追加可）。
- **ノート添付＝個人のみ**（`notes` にワークスペース概念が無いため）。将来 notes を共有化する際に合わせて拡張すること。

**フロント（`index.html`）**
- 添付関数群を新規追加（コメント関数群の直前）：`_attSectionHTML` / `initAttachments` / `_attRenderList` / `_attUpload` / `attSignedUrl` / `_attPurgeForParent`、および拡大モーダルでも動くインラインハンドラ `window._attOnPick/_attDragOver/_attDragLeave/_attDrop`。
- `renderDrawer`（タスク詳細）・`renderNoteDrawer`（ノート詳細）にコメント欄の直前で `_attSectionHTML(scope,id)` を挿入し、描画後に `initAttachments(scope,id)` を呼ぶ（コメント欄と同じ遅延ロード方式）。
- `handleAction`（`document` click 委譲）に `dt-att-toggle`（開閉）/`att-pick`（ファイル選択）/`att-del`（削除）分岐を追加。
- アップロードは**クライアント直** `SB.storage.from('attachments').upload()` → `attachments.insert()`。insert 失敗時は `storage.remove()` でロールバック。表示は毎回 `createSignedUrl(3600)`（メモリキャッシュ、期限30秒前で再発行）。画像はサムネイル、他はファイルチップ。
- プラン別の単体サイズ上限をクライアント一次チェック（free=10MB / それ以外=25MB。`getUserPlan()` 参照）。実効上限はバケット `file_size_limit`。
- タスク/ノート本体削除時（`delTask`/`delNote`）に `_attPurgeForParent` で Storage 実体を掃除（FK CASCADE は行のみ削除し実体は残るため）。

### セキュリティチェック結果（該当：個人データを扱う新規テーブル）
- `attachments` は CREATE と同一マイグレーション内で RLS 有効化＋4ポリシーをセットで作成（CLAUDE.md 規約遵守）。`rls_enabled=true` を実確認。
- Supabase MCP でライブ RLS 検証（すべてトランザクション内 ROLLBACK・本番データ無変更）：
  - 本人＝自タスク/自ノートへの添付 INSERT 成功・SELECT 可視。
  - 他人＝本人の個人タスク/ノート添付は SELECT 0件・INSERT は RLS 拒否。
  - 共有タスク＝メンバーは所有者分＋自分分の添付を閲覧可・自分名義 INSERT 可。非メンバーは SELECT 0件・INSERT 拒否。
- `get_advisors`（security）で **新規 `attachments` 起因の WARN はゼロ**（既存の他アプリ由来 `housecleaning_*`/`reno_*`/`kotobakake_*` 等の WARN のみ残存＝スコープ外）。
- 認証・決済フローは変更なし（`getUserPlan()` を参照するのみ）。Google OAuth スコープ追加も不要。anonキー露出前提・service role はサーバー側のみの原則は不変。

### 触れなかった / 今後の課題
- **プラン別の総容量クォータ**は未実装（現状は単体サイズ上限のみ）。厳格化が必要なら `attachments` に BEFORE INSERT トリガを追加し `user_plans` と突合する。
- **孤児掃除の cron**（Storage実体と `attachments` 行の不整合を service role で突合・掃除）は任意の follow-up。`supabase/functions/cron-cleanup-notifications` が雛形。
- 拡大モーダル（PC最大化）では ID 重複により添付リストのライブ更新が主ドロワー側を指す既知の制約あり（コメント欄と同じ挙動）。アップロード自体は成立し、再オープンで反映される。
- HEIC 等モバイル写真は MIME 許可リストに含めたが、必要なら将来クライアントで jpeg 変換を検討。

### 追記: 添付を「有料プラン限定」に変更（2026-08-09）
ユーザー要望で、添付機能を**有料プラン（standard以上）限定**にした。方針：**アップロード(追加)のみ有料限定／閲覧・ダウンロード・削除は全プラン可**（コスト要因＝保存のみ抑制。共有ワークスペースの無料メンバーも、有料メンバーが付けた既存の添付は閲覧・DLできる）。

- **マイグレーション `supabase/migrations/20260811_attachments_paid_only.sql`（ライブ適用済み）**
  - ヘルパー関数 `auth_is_paid()` を新設：`user_plans`（email主キー）を `auth.jwt()->>'email'` で引き `plan <> 'free'` を返す。**SECURITY INVOKER**（本人行はuser_plansのRLSで読めるためDEFINER不要・再帰リスク無し）、`search_path=public` 固定、anonへEXECUTE付与なし → **security系advisorを一切出さない**。
  - `attachments` INSERT ポリシーと `storage.objects`（バケットattachments）INSERT ポリシーに `auth_is_paid()` を必須条件として追加（drop→recreate）。**SELECT/UPDATE/DELETE は変更せず**＝閲覧・DL・削除は据え置き。
- **フロント（`index.html`）**
  - `showUpgradeModal` の cfg に `attachments` キー追加（`1738`付近）。
  - `_attSectionHTML()` を `isPlanFree()`（=`!getPlanDef().team`。free だけ team=false ＝「非free＝有料」判定）で分岐。無料は🔒ロック表示＋`data-a="att-upsell"`（file input/ドラッグ無効）、有料は通常ドロップゾーン。**att-list は両方描画**（無料でも既存/共有添付を閲覧・DL可）。
  - `_attUpload()` 先頭に `if(isPlanFree()){showUpgradeModal('attachments');return;}`（ドラッグ&ドロップ経路の防御）、`handleAction` に `att-upsell` 分岐追加。
- **セキュリティ検証（Supabase MCP・全てトランザクション内 ROLLBACK・本番無変更）**
  - free ユーザーの添付 INSERT → **RLS拒否**。premium ユーザー → 許可。
  - 共有タスクで：premium所有者はアップロード可／**無料メンバーはアップロード不可**かつ**既存の共有添付は閲覧可（SELECT据え置きを実証、count=1）**。
  - `get_advisors`(security)：**`auth_is_paid` 由来の新規WARNゼロ**（SECURITY INVOKER＋search_path固定＋anon剥奪により該当なし）。既存の他アプリ由来WARNのみ残存。
- **注意**：クライアント判定はUX用で、実防御はRLS。無料ユーザーはAPI直叩きでも添付INSERT不可（サーバー側で強制）。`user_plans` を新規プランに拡張しても `plan <> 'free'` 判定なので自動的に有料扱いになる。

---

## 決済（Stripe）セキュリティ監査・穴埋め（2026-08-09）

### 背景
「セキュリティ攻撃が多い、決済はStripe」との依頼で、決済まわりに絞ってコードベース＋ライブDBを監査。
組み込みスキル `/security-review`（差分レビュー）に加え、CLAUDE.mdの決済チェック項目＋Supabase MCPでの
ライブ検証を組み合わせて実施した。

### 監査結果サマリ
**問題なし（変更せず）**
- Webhook署名検証：`supabase/functions/stripe-webhook/index.ts` で `constructEventAsync` により生ボディ検証・失敗時400。正しい実装。
- 秘密鍵：`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`SB_SERVICE_ROLE_KEY` はすべて `Deno.env.get()` 経由。リポジトリ・フロントにハードコードなし。フロント露出はanonキーのみ（設計上OK）。
- カード情報：Stripe Payment Links / 顧客ポータルでStripe側処理。アプリを通らない。
- `stripe-portal` のJWT検証：`getUser()` により本人の `stripe_customer_id` のみ操作。
- `admin_update_plan` 等のSECURITY DEFINER関数：内部で `mstd0520@gmail.com` にガード済みかつ操作対象は別アプリ(献立)の `menu_*` テーブル。Taskraスコープ外・安全。

**発見して修正した穴**
1. ★**プラン改ざん（無償プレミアム化）**：`user_plans` の INSERT ポリシー `users insert own plan` が `plan` カラムを制約しておらず、行未作成の新規ユーザーが匿名API経由で `{email:自分, plan:'premium'}` を直接INSERT可能だった（ライブで再現確認）。さらに `user_plans`/`ai_usage` は `anon`/`authenticated` に全DML権限が付与され、防御がRLS一本頼りだった。
2. 管理者allowlistに誤り：DBポリシー・フロント両方に `masamune.endo@gmail.com`（誤）と `mstd0520@gmail.com`（正）の2件がハードコードされていた。
3. `stripe-portal` のCORSが `Access-Control-Allow-Origin: '*'`（ワイルドカード）だった。

### 実施した変更
**DB（マイグレーション `supabase/migrations/20260809_harden_user_plans_security.sql`／ライブ適用済み）**
- `user_plans` INSERTポリシーを `email = auth.jwt()->>'email' AND plan = 'free'` に制約（プラン昇格を封鎖。正規の初回free登録は影響なし）。
- `user_plans` 管理者ポリシー `admin full access` を **`mstd0520@gmail.com` の単一アカウント**に限定。
- `anon` から `user_plans`/`ai_usage` の全権限を `REVOKE`（未ログインからのアクセス遮断）。
- 検証：一般ユーザーJWTでの premium 自己INSERT／他人emailでのINSERTはRLSで拒否、本人 `free` INSERTは成功をライブ確認。

**Edge Function（`supabase/functions/stripe-portal/index.ts`／ライブ deploy 済み version35）**
- CORSを許可オリジン `https://app.taskra.jp` のみに限定（`verify_jwt:true` は維持）。プリフライトで非許可オリジンにマッチ値を返さないことを確認。

**フロント（`index.html`）**
- `ADMIN_EMAILS`（1359行付近）を `['mstd0520@gmail.com']` に修正。クライアント判定はUI表示用で、実防御はDB側RLSにある旨コメント追記。

### テーブルとRLSの状態（変更後）
- `user_plans`：RLS有効。ポリシー3件（SELECT=本人 / INSERT=本人かつfree / ALL=管理者mstd0520のみ）。GRANT=authenticated,service_roleのみ（anon剥奪）。
- `ai_usage`：RLS有効。ポリシー2件（管理者のみSELECT/UPDATE）。GRANT=authenticated,service_roleのみ（anon剥奪）。

### 触れなかった / 触ってはいけないと判断した箇所
- Webhook署名検証ロジック、secret/service roleの取り扱い（現状維持）。
- 別アプリ由来テーブル（`housecleaning_*`/`kotobakake_*`/`reno_*`/`menu_*` 等）と `admin_*` RPC（Taskraスコープ外。ただしadvisorに `rls_enabled_no_policy` や `function_search_path_mutable` 等のWARNが多数残っている。別途対応を推奨）。
- 本番Stripe Price ID / Payment Link URLの実値。

### 次にやるべきこと
- Supabase Auth の「Leaked Password Protection」有効化（advisor WARN。ただし本アプリはGoogle OAuthのみのため優先度低）。
- スコープ外テーブルのRLSポリシー整備（別セッションで対応推奨）。
- 実機でプラン管理画面（管理者）とプラン購入→Webhook→プラン反映の一連が正常動作するか確認。

---

## シークレットメモのボトムシート: スマホでキーボードが入力欄を隠すバグを修正（2026-08-03）

### 概要
スマホ（主にiOS Safari）でシークレットメモのボトムシート内の入力欄（例:「合言葉をもう一度入力」）に
カーソルを当てるとソフトキーボードが出て、下部の入力欄や「次へ」ボタンが**キーボードに隠れて見えなく
なる**バグを修正。

### 原因
ボトムシート `.sm-overlay` は `position:fixed; inset:0` ＋ `align-items:flex-end` で画面**下端**に固定。
`position:fixed` はレイアウトビューポート基準なので、キーボード表示で**実際に見えている領域（visual
viewport）が縮んでも縮まず**、シート下部がキーボードの裏に回り込んでいた。

### 修正（`src/secret-memo.js`）
- 全シート共通の入口 `openSheet` に **VisualViewport 追従**を追加。`visualViewport` の
  `resize`/`scroll` を購読し、オーバーレイの `top/left/width/height` を可視領域に合わせて更新
  （`bottom/right` は `auto` で打ち消し）。これでシートが常にキーボードの上に収まる。シート閉時に
  リスナーを解除。
- `focusin` で入力欄（INPUT/TEXTAREA）を `scrollIntoView({block:'center'})` し、フォーカス直後にも
  可視領域中央へスクロール。
- CSS: `.sm-sheet` の `max-height` を `90dvh` → `min(90dvh,100%)`（オーバーレイ＝可視領域を超えない）、
  慣性スクロール用に `-webkit-overflow-scrolling:touch` を追加。
- 対象は `openSheet` 経由の全シート（初回セットアップ / 解錠 / 復元 / 合言葉変更）に一括適用。

### 影響範囲・セキュリティ
- **UIのみの変更**。認証・決済・DB/RLS・暗号ロジック（`src/lib/crypto.js`）には一切非該当・無改変。
- `index.html` は `src/secret-memo.js` を `<script type="module">` で直接読み込み（ビルド不要）。

### 次にやるべきこと
- 実機（iOS Safari / Android Chrome）でセットアップ画面の2つ目の入力欄・「次へ」がキーボード上に
  出ることを確認。

---

## シークレットメモをノート(Note)にも対応＋タスク⇔ノート変換の暗号文移行（2026-08-03）

### 概要
これまでタスク専用だったシークレットメモ（E2EE）を **Note にも対応**。合言葉・復元コードは
タスクと**共通**（鍵素材 `secret_key_material` は user_id 単位なので元々1ユーザー1マスター鍵）。
併せて「タスク→Note変換 / Note→タスク変換」でシークレットメモが失われる問題・暗号文が迷子に
なる問題を解消した。

### DB（Supabase）★セキュリティ状態
- **新規テーブル `note_secret_notes`（note_id 主キー）を追加。適用済み・実確認済み**
  （`rls_enabled=true`・ポリシー4件）。マイグレーション: `supabase/migrations/20260803_note_secret_notes.sql`。
  構造・RLSは `task_secret_notes` と同一（**所有者のみ** `user_id = auth.uid()`）。
- `secret_note` は base64(iv+AES-GCM暗号文)。検索・AI・LINE通知の対象外（タスク側と同じ扱い）。

### 変換時の暗号文移行（キモ）
- `encryptNote` は AES-GCM を **AAD なし**で使うため、暗号文blobは対象id（task_id/note_id）に
  **束縛されない**。かつマスター鍵は user 単位で共通。→ タスク⇔ノート変換は
  **blobをテーブル間でそのまま移し替えるだけ**（`SecretMemo.moveSecret(fromKind,fromId,toKind,toId)`）。
  **復号不要・ロック中でも移行可能**。変換で新idが振られてもblob文字列をコピーするだけ。
- 実装フック（index.html）:
  - `task-to-note`（8912付近）: `saveNote` 後に `moveSecret('task',task.id,'note',n.id)`。
  - `note-to-task`（8492付近）: `saveTask` 後に `moveSecret('note',note.id,'task',t.id)`。
  - `delTask` / `delNote`: `onEntityDeleted(kind,id)` で暗号文をクリーンアップ（迷子防止・best-effort）。
  - Note詳細 `renderNoteDrawer`（`#nt-body` 直後）に `mountNoteSection(note)` と検知フックを追加。

### モジュール構成（`src/secret-memo.js`）
- タスク/ノート両対応の**エンティティ汎用**化（`{kind:'task'|'note', id, ownerId}`）。
  公開API: `mountTaskSection` / `mountNoteSection` / `onNotesInput(el)` / `moveSecret` /
  `onEntityDeleted` / `lock`。`onNotesInput` は現在マウント中のエンティティ(`_mountedEntity`)を対象にする。
- 暗号ユーティリティ `src/lib/crypto.js` は**無改変**（元々 user 単位のマスター鍵設計だったため）。

### テスト
- `node --test src/lib/crypto.test.js` … 13件パス（暗号ロジック無改変）。
- Chromium（Playwright, スタブDB）で E2E 確認：セットアップ→タスクに書込→**task→note移行**→
  Note側で解錠すると**元の平文が復元**（同一鍵でblobが復号可能）→**note→task逆移行**→削除クリーンアップ→
  Note側の検知チップ→非所有者への非表示、を全項目パス。

### 影響範囲・触っていない箇所
- index.html は純追加のフックのみ（既存のタスク/ノートCRUD・変換・共有ロジックは無改変）。
- 認証・決済フローの変更なし。`tasks`/`notes` 本体テーブルには手を入れていない。

### 次にやるべきこと
- 本番（app.taskra.jp）で実ログイン下の確認：Noteでのシークレットメモ設定・表示、
  タスク⇔ノート変換でシークレットメモが引き継がれること、変換後に相手（共有）へ露出しないこと。
- フェーズ2: WebAuthn PRF による生体認証解錠（鍵ラップ方式を1つ追加するだけで対応可能な設計）。

---

## シークレットメモ機能（E2EE・フェーズ1）を追加（2026-08-02）

### 概要
タスクにパスワード等の機密情報を平文で書かせないための、エンドツーエンド暗号化メモ。
所有者以外（運営者・DB閲覧権限者・共有ワークスペースのメンバー）は誰も復号できないゼロ知識設計。
今回は**フェーズ1（パスフレーズ＋リカバリーコードによるE2EE）**のみ実装。

### 暗号方式（`src/lib/crypto.js`／純関数・単体テスト可能）
- Web Crypto API のみ（外部ライブラリ不可）。AES-GCM 256bit。
- **マスター鍵方式**：ランダム生成したマスター鍵で secret_note を暗号化。マスター鍵を
  「パスフレーズ由来の鍵（PBKDF2 SHA-256 / 60万回 / ランダムsalt）」と
  「リカバリーコード由来の鍵」の2つでそれぞれラップして保存。
  - パスフレーズ変更は**マスター鍵の再ラップのみ**で完結（secret_note の再暗号化不要）。
  - フェーズ2（WebAuthn PRF）を見据え、`wrapMasterKey`/`unwrapMasterKey` を汎用化し
    「マスター鍵」と「アンロック手段」を分離済み。新しいアンロック手段を足すだけで拡張可能。
- IV は暗号化のたびに `crypto.getRandomValues` で生成し暗号文と共に保存。
- **鍵・パスフレーズ・リカバリーコード・マスター鍵はサーバー送信禁止／localStorage・
  sessionStorage 保存禁止**。マスター鍵は `src/secret-memo.js` のモジュールスコープ変数
  `_masterKey` にのみメモリ保持し、`visibilitychange`（バックグラウンド移行）で即破棄。
- 単体テスト `src/lib/crypto.test.js`（`node --test` / 依存ゼロ）：暗号↔復号ラウンドトリップ、
  リカバリーからのアンラップ、パスフレーズ変更後も既存データ復号可 を含む全13件パス。

### DB（Supabase）★セキュリティ状態
- **新規テーブル2つ。いずれも CREATE と同一マイグレーション内で RLS 有効化＋ポリシー設定済み**
  （マイグレーション: `supabase/migrations/20260802_secret_notes.sql`）。
  - `secret_key_material`（user_id 主キー）：`kdf_salt` / `verification_blob` /
    `wrapped_master_key` / `wrapped_master_key_recovery`。中身はすべてラップ済み or salt で
    単体では復号不可。**RLS: 本人のみ（`user_id = auth.uid()`）**。
  - `task_secret_notes`（task_id 主キー）：`secret_note`＝base64(iv+ct) の暗号文。
    **RLS: 所有者のみ（`user_id = auth.uid()`／ワークスペース句をあえて持たない）**。
- **設計上の重要判断**：secret_note を `tasks` の列にしなかった。理由は、アプリが全タスクを
  `dbAllNoFilter('tasks')`＝`select('*')`（RLS依存）で取得しており、tasks の RLS は共有
  プロジェクト経由でワークスペースメンバーにも SELECT を許可するため、列にすると**共有相手に
  暗号文まで渡ってしまう**。Postgres の RLS は列マスク不可なので、所有者専用テーブルに分離して
  「所有者以外は行ごと取得不能」を構造で保証（多層防御）。
- ✅ **適用済み（2026-08-02）**：Supabase（プロジェクト `sfhtvtcmgueystyuhzvd`）へ適用完了。
  実確認で `secret_key_material` / `task_secret_notes` とも `rls_enabled = true`・ポリシー各4件。
  セキュリティアドバイザー（security）でも本2テーブルに警告なし（RLS漏れ・過剰許可なし）。
  ※アドバイザーが挙げる他の警告（housecleaning_* / kotobakake_* / reno_* / task_logs /
    notifications / admin_* 関数の search_path 等）はすべて**既存の別機能由来でスコープ外**。

### UI/UX（`src/secret-memo.js`・思想: 摩擦最小／文言は「あなただけが読める」で統一）
- タスク詳細の「メモ」セクション直後に🔒シークレットメモセクションを DOM 挿入
  （index.html の巨大な描画文字列は触らず、`mountTaskSection(task)` で `#memo-section` の
  直後に差し込む方式。index.html 側の改修は2フック＋script タグのみ）。
- 初回はセットアップを強制せず、初回タップでボトムシート2ステップ（パスフレーズ＋強度メーター →
  リカバリーコード表示／コピー・DL・「保存した」チェック必須）。
- 解錠：パスフレーズ→`verification_blob` で検証。解錠後も本文は ●●●● マスクし、行タップで
  表示/再マスク（覗き見対策）。コピーは30秒後にクリップボード自動クリア（トースト通知）。
- 平文メモ入力中に pass / PW / パスワード / ID+記号列 等を**ローカル検知**（送信なし）し、
  「シークレットメモに移動しますか?」チップをワンタップ移動＋暗号化。
- 共有タスクでは**所有者以外にセクション自体を非表示**（`isOwner()` でUIレベル排除）。
  所有者側には「このメモはあなた専用です…」を常時表示。
- リカバリー（コード入力→アンラップ→新パスフレーズ設定）、パスフレーズ変更（再ラップのみ）実装。

### 影響範囲・触っていない箇所
- 既存の**タスクCRUD／Gantt／通知／ワークスペース共有には影響なし**（index.html の変更は純追加の
  2フックと script タグのみ、既存ロジック無改変）。認証・決済フローの変更なし。
- secret_note は**検索対象外・AIアシスタント連携対象外・LINE通知対象外**（コード＆UIに明記）。
  既存の検索/AI/LINE 機能は `task_secret_notes` を参照しない。

### 次にやるべきこと
- 本番（app.taskra.jp）で実ログイン下の解錠・保存・共有非表示の動作確認
  （※フロントは main マージ後に GitHub Pages へ反映されるため、マージ後に確認）。
- フェーズ2: WebAuthn PRF 拡張による生体認証解錠（鍵ラップ方式を1つ追加するだけで対応可能な設計済み）。

---

## 管理者パネルのプラン管理に「並び替え」を追加（2026-08-02）

### 背景
登録日を追加したので、新規ユーザーを把握しやすいよう一覧の並び替えを可能に。

### 設計方針
テーブルヘッダのクリック並び替えはスマホでヘッダが非表示（カード化）になり使えないため、
**スマホ／PCで一貫して使える並び替え `<select>`** をフィルタ行に設置。

### 実装内容（`index.html` の `openPlanAdmin` のみ）
- 状態 `planSort` を追加（既定 `created_desc` ＝**登録日が新しい順**）。
- 選択肢：登録日が新しい順 / 登録日が古い順 / メール順（A→Z）。
- `getFilteredPlans()` でフィルタ後にソート（`created_at` を数値化、null/不正値は 0 として扱い desc では末尾）。フィルタ＋ソート併用可。
- フィルタ行に `#plan-sort` セレクトを追加し `onchange` で再描画（ページは先頭へ）。「クリア」はフィルタのみ解除（並び順は維持）。
- 既定を「新しい順」に変更（従来はメール順）。メール順は選択肢として残置。

### セキュリティ・影響範囲
- **フロントの表示ロジックのみ**（クライアント側ソート）。DB・認証・決済・個人情報・クエリは無変更。

---

## 管理者パネルのプラン管理に「登録日」を追加（2026-08-02）

### 背景
管理者が登録日をメモ欄に手入力（例「5/19登録を確認」）して運用していたため、正式な項目として表示。

### DB調査の結論：カラム新設は不要
`public.user_plans` に既に **`created_at`（timestamptz, default now()）** が存在し、値も実際の登録日として妥当（例：`260097@sakura-h.ed.jp` の created_at=2026-05-18 23:50 UTC＝**JST 5/19**で、管理者メモ「5/19登録を確認」と一致）。よって **`created_at` を登録日として採用**。新規カラムは作成していない。

### 実装内容（`index.html` の `openPlanAdmin` のみ）
- 登録日フォーマッタ `fmtRegDate()` を追加（`created_at` を **`Asia/Tokyo` で YYYY/MM/DD** 表示。null/不正値は「—」）。
- `buildPlanTable` に「登録日」列を追加（メール→プラン→**登録日**→メモ→削除）。スマホカードでは「登録日」ラベル付き行として表示。
- データ取得は既存の `select('*')` のまま（`created_at` は取得済み）＝**クエリ変更なし**。

### セキュリティ・影響範囲（重要）
- **DBスキーマ変更なし**（テーブル/カラムの新設なし、マイグレーション未実行）。**RLSの状態も不変**。
- `created_at` を**表示するだけ**の改修。認証・決済・個人情報の取り扱い・書き込みロジックは一切変更なし。
- `user_plans` テーブル：RLS状態は本改修では未変更（今回は読み取り表示のみ）。

---

## モーダルが縦に長いときスクロールできない不具合を修正（2026-08-02）

### 背景 / 問題
`.modal` に `max-height` / `overflow-y` が無く、内容がビューポートより高くなると
**はみ出すだけでスクロールできない**（overlayが中央寄せflexのため上下が画面外にクリップ）。
管理者パネルのカード化で縦が伸び顕在化したが、原因は全モーダル共通のCSS。

### 実装内容（`index.html` の `.modal` のみ）
- `.modal` に `max-height:calc(100dvh - 40px)`（`100vh`フォールバック付き）＋ `overflow-y:auto` ＋ `-webkit-overflow-scrolling:touch` を追加。
- 高さがビューポート未満のモーダルはmax-height未満なので**従来どおり（影響なし）**、高いモーダルだけ内部スクロールする。
- `dvh` はモバイルのURLバー可変高さに追従させるため（非対応環境は直前の`vh`指定にフォールバック）。
- Playwright（390×740）で内容過多時に内部スクロール成立（最下部の「閉じる」まで到達）・ページ全体の縦あふれ無しを確認。

### セキュリティ・影響範囲
- **CSS 1行の表示改修のみ**。認証・決済・DB・個人情報は無変更。

---

## 管理者パネル（プラン管理／AI利用状況）をスマホでカード表示に再構成（2026-08-02）

### 背景 / 問題
管理者パネル（`openPlanAdmin`）の一覧は横並びテーブル（`.admin-table`）で組まれており、
スマホ幅ではモーダル（`max-width:640px / width:95vw`）に収まりきらず**「メモ」列と削除ボタンが画面右外にクリップ**され、
モーダル内は横スクロールも効かないため**実質操作不能**だった。

### 設計思想
テーブルは「列同士の比較」に最適なUI。だが管理者がスマホでやる本当のジョブは
「特定ユーザーを検索して、その人のプランを1つ変える」＝**単一レコードの参照＋編集**。
そこで狭幅では表を縮めるのではなく **「1レコード＝1カード」に構造ごと再構成**し、情報に階層をつけた：
- **メール（識別子）＝カード見出しに昇格**
- **プラン（操作対象）＝ラベル＋タップしやすいselect**
- **メモ・利用回数など＝ラベル付きで下段**
- 削除（破壊操作）はカード右上に固定して誤爆を回避。

### 実装内容（`index.html` のみ・表示改修）
- CSSに `@media(max-width:560px)` を追加し、`.admin-table` を `display:block` 化してカード表示に切替（**PC幅はテーブルのまま**＝レスポンシブは"縮小"でなく"出し分け"）。
- 各 `<td>` に `data-label`（`::before`でラベル表示）とクラスを付与：
  - `.ad-title`（メール＝見出し）／`.ad-act`（削除＝右上固定）／`.ad-reset`（リセット＝カード下部に全幅）。
- 対象は「プラン管理」テーブルと「AI利用状況」テーブルの両方（`buildPlanTable` / `buildUsageTable`）。
- Playwright（Chromium・390px/900px）で検証：モバイルで**横はみ出しゼロ（scrollWidth==clientWidth）**、JSエラーなし、PC幅はテーブル維持を確認。

### セキュリティ・影響範囲
- **表示（CSS・DOMの属性追加）のみ**の改修。**認証・決済・DB・RLS・個人情報の取り扱いは一切変更なし**。
- `user_plans` / `ai_usage` への読み書きロジック（既存のSupabaseクエリ）は無変更。秘匿情報の追加なし。
- 触っていない箇所：プラン変更の反映ロジック、AI利用回数のカウント/リセットの実処理、管理者判定（`isAdmin()`）。

---

## devs.html の共有モーダルに「リンク送信・URLコピー」を追加（遠隔共有対応）（2026-08-02）

### 背景
PWA（standalone表示）ではURLバーが隠れ、**ページ自体のURLをコピーして LINE 等で送れない**という困りごと。
QRは「対面共有」を解決済みだが「遠隔共有（リンクを送る）」が未対応だった。
→ ユーザーの本当のジョブは「コピー」そのものではなく「相手に送る」。安直にコピーだけ足すのではなく、
**モーダルを『見せる（QR＝対面）＋送る（リンク＝遠隔）』の共有ハブに再定義**した。

### 実装内容（`devs.html` のみ・外部依存なし）
- QR共有モーダルに遠隔共有アクション行を追加：
  - **「リンクを送る」**＝`navigator.share()` でネイティブ共有シート（LINE/メール/AirDrop等）を起動。スマホ最短導線。
  - **「URLをコピー」**＝`navigator.clipboard.writeText()`。失敗時は隠しtextarea＋`execCommand('copy')`で確実にコピー。押下で「コピーしました ✓」に1.6秒だけ変化（alertは出さない）。
- **プログレッシブ・エンハンスメント**：`navigator.share` 対応環境は「送る（主）＋コピー（副）」、非対応（PC等）は送るを隠しコピーを主役に昇格。
- 複数URL（アプリ/LP）は**トグルで選択中のURL**を送る/コピー（QR表示と一貫）。URL切替時にコピー表示はリセット。
- **フッターを「このページを共有（QR・リンク送信・コピー）」に格上げ** → PWAでURLバーが隠れていても、フッターから1タップでこのページをLINE送信/コピー可能に（本件の主目的を正面から解決）。
- ヒント文を「目の前の人はQRを読み取り／離れた人へはリンクで送れます」に更新。
- Playwright で share対応/非対応の両ケース、送るpayload、トグル連動URL、クリップボード内容、コピー表示リセットまで検証済み（JSエラーなし）。

### セキュリティ・影響範囲
- 静的HTMLの表示改修のみ。認証・決済・DB・個人情報は未変更。秘匿情報なし。
- `navigator.clipboard` / `navigator.share` は https のセキュアコンテキスト（app.taskra.jp）＋ユーザー操作起点で動作。

---

## 開発プロダクト一覧ページ（devs.html）にQR共有機能とセグメント分割を追加（2026-08-02）

### 背景
飲み会などの場で、相手のスマホにサッとアプリを見せたい。そのため各プロダクトのURLをQR化。
ただし**QRを画面に並べると隣接QRを誤読する**問題があるため、「画面上に露出するスキャン可能なQRは常に1枚だけ」という不変条件で設計した。

### 実装内容（`devs.html` のみ・静的LP）
- **QR共有UI（モーダル方式）**
  - 各プロダクトカードに「QRで見せる」ボタンを設置。タップで**モーダルに大きなQRを1枚だけ**表示（背景暗転）。
  - アプリ/LPなど複数URLを持つプロダクトは、モーダル内のトグルで切替（それでも可視QRは常に1枚）。
  - QRは **segno で生成したインラインSVG**（`<symbol>` スプライト＋`<use>`）。**外部ライブラリ・外部API・画像への依存ゼロ**。オフラインでも表示可能。
  - 白カード＋パディングでクワイエットゾーン（静寂域）を確保し、スキャン率を担保。
  - カード上／フッターのQRアイコンは**装飾用の別アイコン（`#ic-qr`・データQRではない＝スキャン不可）**。実スキャンはモーダル内の1枚だけ。
  - フッターの「このページのQR」も同じモーダル機構に統合（旧コミットで参照が壊れていた `#qr-devs` / `.qr-modal-title` 等を修正）。
  - Playwright（headless Chromium）で描画→スクショ→**opencvでQRデコードし全URL一致を確認済み**。
- **プロダクト一覧のセグメント分割**
  - 上部「🚀 Personal Works（個人開発プロダクト）」：Taskra / Flowra / Tavera（個人で作りリリース・運営）。
  - 下部「🏢 Business / Client（事業・受託プロダクト）」：MEOエージェント / RENO / FOOD AI / MIRRA。
  - 注意：ここでの「個人／事業」は**開発主体の区分**であり、カード内バッジの「個人向け／法人向け」（＝ターゲット層）とは別概念。混同しないよう英語のエディトリアル見出しで区別している。
- **Tavera のステータスを「開発中」→「リリース済み」に変更**（開発完了のため）。アプリ/LPが同一URLだったためリンクを1本に集約。

### セキュリティ・影響範囲
- 認証・決済・DB・個人情報には**一切変更なし**（静的HTMLの表示改修のみ）。RLSやEdge Function、Stripe周りは未変更。
- 秘匿情報（APIキー・トークン等）はdiffに含まれない。
- 触っていない箇所：`index.html`、Supabase、Stripe、他プロダクトのリポジトリ。

### 既知の別課題（今回スコープ外・未修正）
- `devs.html` 最下部「開発サービス一覧」セクションの見出し（`section-tag` / `section-title` / `section-desc`）が**暗背景に暗文字で視認できない**。CSSクラス未定義＆`--navy`色の使い回しが原因。今回の依頼範囲外のため未着手。要判断。

---

## 🚨 タスクの中身が丸ごと消える重大バグを修正（autosaveのガード欠如）＋消えたデータを復旧（2026-08-01）

### 報告内容

「mstd0520@gmail.com のアカウントで『日報承認』というタスクが消えた。今朝10時ころまではあった」

### 調査結果：タスクは削除されていない。中身だけが空で上書きされていた

Taskraのタスク削除は物理削除（`dbDel()`）でゴミ箱がないため「消えた＝削除」と疑ったが、
**実際にはレコードは生きていて、中身が空になっていた**。

対象は `tasks.id = 'mr1f6ltzdgzt'`（`status='active'`）。同一タスクである根拠：

| 項目 | `mpv2sn7v4ocv`（7/1に完了した元タスク） | `mr1f6ltzdgzt`（空になっていたタスク） |
|---|---|---|
| `tag_ids` | `["mofnrntnc4l3"]`（仕事） | `["mofnrntnc4l3"]` ← 一致 |
| `sort_order` | `2000` | `2000` ← 一致 |
| 時刻 | `completed_at` = 07-01 01:51:41.**787** | `created_at` = 07-01 01:51:41.**831** ← 44ms後 |

2026-07-01に「日報システム（開発）承認」（`repeat_rule='monthly'`）を完了した際、
`nextRepeat()` が8月分として生成したタスクがこれ。`updated_at` は
**2026-08-01 01:12:36 UTC（JST 10:12）** で、ユーザーの証言と一致。その2分後の10:14に
ユーザーが「開発日報承認（月初）」（`ms9oiuybtyds`）を手で作り直していた。

### 原因：`renderDrawer()` 内 autosave のDOM存在ガード欠如（index.html 6736行目付近）

```js
// 修正前
autosave._t=setTimeout(async()=>{
  const t2=S.tasks.find(x=>x.id===S.taskId);if(!t2)return;   // ← ガードはこれだけ
  t2.title=document.getElementById('dt-title')?.value||'';    // 要素が無ければ ''
  t2.notes=document.getElementById('dt-notes')?.value||'';    // 要素が無ければ ''
  t2.dueAt=document.getElementById('dt-due')?.value||null;    // 要素が無ければ null
  t2.startAt=document.getElementById('dt-start')?.value||null;
  t2.plannedStartAt=document.getElementById('dt-planned-start')?.value||null;
  t2.startTime=document.getElementById('dt-start-time')?.value||null;
  t2.projectId=document.getElementById('dt-proj')?.value||null;
  t2.assigneeId=document.getElementById('dt-assignee')?.value||null;
  t2.repeatRule=getRepeatRule();     // #dt-repeat が無いと null を返す（2537行目）
  await saveTask(t2);
},400);
```

`?.` で要素の不在を握りつぶしたうえ、`|| ''` / `|| null` にフォールバックして**無条件に代入**していた。
ガードは「Stateに対象タスクがあるか」だけで、**ドロワーのDOMがまだ存在するかを見ていなかった**。

そのため400msのデバウンス待ちの間に「ドロワーを閉じる」「別タスク/ノートに切り替える」
「`render()` でDOMが作り直される」のいずれかが起きると、`getElementById` が軒並み `null` を返し、
**タイトル・メモ・期限・開始日・計画開始日・開始時間・プロジェクト・担当者・繰り返しルールが
一斉に空で保存される**。

DBの被害内訳がこの挙動と完全に対応していた：

- autosaveが**書き込む**カラム → `title` `notes` `due_at` `start_at` `planned_start_at`
  `startTime` `project_id` `assignee_id` `repeat_rule` … **全滅**
- autosaveが**触らない**カラム → `tag_ids` `sort_order` `status` `priority` `flagged` … **無傷**

同じファイルの**PC拡大モーダル側のsave（9341行目付近）は `if(titleEl)t.title=...` と正しくガード
していた**ため、ドロワー側だけガードが無いという非対称がそのままバグになっていた。

### 修正内容（index.html、1箇所）

`renderDrawer()` 内 autosave のデバウンスコールバックに2層の防御を追加：

1. **ドロワーが対象タスクを表示中でなければ保存自体を行わない**
   （`drEl._taskId!==t2.id` を利用。`dr._taskId` は6719行目で設定済み、
   ノート表示中は6171行目で `null` になるため、ノートに切り替わった場合も弾ける）
2. **各入力欄は「存在する場合のみ」反映**（拡大モーダル側と同じ `if(el)` 方針に統一）。
   これによりガードをすり抜ける未知の経路があっても、欠けている欄は既存値が保持される

ユーザーが**実際に入力欄を空にした場合は従来どおり空で保存される**（意図的なクリアは尊重）。

### 復旧したデータ

`mr1f6ltzdgzt` に対し、元タスク `mpv2sn7v4ocv` と `nextRepeat()` の計算結果から
**autosaveが破壊したフィールドのみ**をSQLで復元（Supabase MCP経由）：

```
title='日報システム（開発）承認' / notes='[日報システム](https://nps.dev-xaas.jp/admin/report-shonin)'
due_at='2026-08-01' / start_at='2026-08-01' / planned_start_at='2026-05-29'
"startTime"='09:00' / project_id='mqozct6zbrz5'（会社定期業務） / repeat_rule='monthly'
```

- **`priority` は 4 のまま意図的に据え置いた**。元タスクは `priority=1` だが、autosaveは
  priorityを書き換えないため、4になっているのは別要因（ユーザー自身の優先度変更と推定）。
  バグ由来でないフィールドは触らない方針とした
- `repeat_rule` が失われていたため、**放置していれば9月分以降も生成されなくなっていた**

### 動作確認

- Node.js構文チェック：3インラインscriptブロックともJS_OK
- ブラウザ拡張が未接続だったため、**index.htmlからautosaveのデバウンス本体を実コードのまま
  抽出し、DOM/Stateをスタブして直接実行するテストを作成**して検証（4ケース）：
  1. ドロワーDOM消失中に発火 → 修正前:8フィールド全損+DB保存あり / **修正後:変化なし・保存なし**
  2. 別タスクに切り替わった状態で発火 → 修正前:8フィールド全損 / **修正後:変化なし・保存なし**
  3. 正常系（対象タスク表示中） → 修正前後とも正常に保存（リグレッションなし）
  4. ユーザーが実際に空にした場合 → 修正後も空で保存される。かつ未描画の欄
     （`#dt-start` 不在）は既存値が保持される（修正前は null で潰れていた）
- 修正前のコード（`git show HEAD:index.html`）で同テストが3件FAILすることを確認済み＝
  テスト自体が有効に機能している
- **実ログイン環境での最終確認は未実施**。次にこのファイルを触る人は、本番で
  「タスク詳細でタイトル/メモを編集 → 400ms以内にドロワーを閉じる or 別タスクに切り替える」
  を試し、内容が保持されることを確認してほしい

### セキュリティチェックの判定

- 認証・決済（Stripe）・RLS・DBスキーマには一切触れていない（フロントの保存ロジックのみ）
- データ復旧のため `tasks` テーブルに対しSupabase MCP経由でUPDATEを1行実行した
  （`where id='mr1f6ltzdgzt'` で限定。スキーマ・ポリシー変更なし）
- 新規/変更したテーブルなし、RLS状態の変更なし、認証・決済フローの変更なし

### 触れなかった箇所・次にやるべきこと

- **`ms9oiuybtyds`「開発日報承認（月初）」（今朝ユーザーが作り直したもの、`repeat_rule='monthly:1'`、
  `due_at=2026-08-04`）と復元した `mr1f6ltzdgzt` が内容的に重複している。**
  どちらを残すかはユーザー判断が必要（未処理）
- 同種の被害を受けて生き残っているタスクは他になし（空タイトルの `active` タスクを全走査して確認）。
  ただし**空タイトルの `completed`/`archived` タスクが約100件存在する**。これらは `due_at` 等が
  残っているため別要因（タイトル未入力のまま作成されたもの）と判断したが、未検証
- **繰り返しタスクの完了時はundoトーストが出ない**（8276〜8289行目。undo付きトーストは
  繰り返しでない場合の `else` 側のみ）。誤って完了させると戻す手段がその場にないため、
  改善余地あり（今回のスコープ外）
- `nextRepeat()` は `status:'active'` を固定で上書きするため、**Inboxで管理していた繰り返しタスクを
  完了すると次回分がInboxビュー（`x.status==='inbox'` の完全一致、2838行目）に出てこない**。
  今回の件とは別の潜在バグ。未修正
- ノート側の autosave（`renderNoteDrawer()` 内 `schedSave()`、6206行目付近）は**調査済みで問題なし**。
  タスク側と違い ①`titleEl`/`bodyEl` を描画時にキャプチャした変数で保持している（DOMが作り直されても
  detachedな要素から入力値を読めるため空にならない）②保存対象が `S.noteId` から引き直した別オブジェクト
  ではなく、描画時にキャプチャした `note` 自身 — の2点により、同じ事故は構造的に起きない。
  **タスク側だけが `document.getElementById` で毎回引き直し、かつ `S.taskId` から対象を引き直していた**
  のが今回の原因だった

---

## 🆕 Forecast日付一覧が空になる不具合／Overdueの一括「全選択」が機能しない不具合を修正（2026-07-31）

### 報告内容

1. Forecastの各日付（例：30日）のタイトル部分をクリックしても、その日のタスク一覧に何も表示されない
2. Overdueビューで一括処理モードに入り「全選択」をクリックしても選択されない（個別タップでの選択は機能する）

### 原因（2件とも同一パターン：`renderList()`のサブタスク表示許可リスト漏れ）

`renderList()`（index.html 5402行目付近）は、ビューによって「サブタスクも一覧に含めるか」を
`showSubsInView`という配列（`['today','flagged','overdue','assigned']`）で判定している
（2026-07-14の「Assignedビューのバッジ件数とリスト表示件数の不一致」修正で導入されたもの）。

1. **Forecast一覧が空になる件**：Forecastの日付クリックで遷移する`forecast-day`ビューが
   この配列に含まれていなかった。一方、Forecastのグリッド表示（`renderForecast()`）自体は
   サブタスクを除外せずにカウント・表示しているため、グリッド上は「5件」等と出るのに、
   クリック後の一覧（`getTasks()`→`renderList()`）ではサブタスクだけが除外されて0件になり、
   「何も出てこない」ように見えていた。該当日のタスクが全てサブタスクの場合に症状が発生する
   （一部だけサブタスクの場合は「グリッドの件数より一覧の件数が少ない」という分かりにくい形になる）
2. **Overdue全選択が機能しない件**：一覧表示自体は`overdue`が対象配列に入っているため
   サブタスクも表示されるが、「全選択」ボタンのハンドラ（`bulk-sel-all`、9073行目付近）は
   従来`getTasks().filter(t=>!t.parentTaskId)`と**常にサブタスクを除外**する実装のままだった。
   つまり「一覧に表示されている行」と「全選択で選ばれる行」の基準がズレており、
   Overdueの対象タスクがサブタスク中心だと全選択の結果が0件（またはごく一部）になり、
   ユーザーからは「全選択が機能しない」ように見えていた。個別タップ選択（`sel`アクション、
   8121行目付近）はサブタスクを除外していないため、そちらは正常に選択できていた

### 修正内容（index.html、2箇所）

1. `renderList()`の`showSubsInView`配列に`'forecast-day'`を追加
2. `bulk-sel-all`ハンドラ内で、`renderList()`と同じ`showSubsInView`判定
   （`['today','flagged','overdue','assigned','forecast-day']`）を追加し、
   対象ビューではサブタスクも全選択に含めるよう修正（他ビューは従来通りサブタスク除外を維持）

### 動作確認

- Node.js構文チェック：3インラインscriptブロックともJS_OK
- ローカル静的サーバー（`.claude/static-server.js`）+ ブラウザのJS実行環境でダミータスクを注入し確認：
  - 親タスク配下のサブタスクにのみ期限日を設定 → Forecastグリッドでその日をクリック →
    修正前は一覧0件、修正後はサブタスクが一覧に表示されることを確認
  - Overdueビューでサブタスクを含む状態で「一括」→「全選択」を実際のDOMクリックイベント経由で
    実行 → 修正前はサブタスクが選択対象から漏れ、修正後は`S.selectedIds`にサブタスクIDが
    含まれることを確認（350msの連打防止デバウンスの影響を受けないよう、ボタン間隔を空けて検証）
- Google OAuth未実施のため、実データでの最終確認は次にこのファイルを触る人に要フォロー

### セキュリティチェックの判定

- フロントエンドの一覧フィルタ・選択ロジックのみの変更。認証・決済（Stripe）・DBスキーマ・RLS・
  個人情報の扱いには一切触れていない（セキュリティチェック対象外）

### 触れなかった箇所・次に踏む可能性がある同種の潜在バグ

- `showSubsInView`と`bulk-sel-all`の判定基準は今回で一致させたが、**この2箇所は今後も
  手動で同期が必要な重複配列**になっている。将来ビューを追加する際は両方を同時に見直すこと
  （共通関数化も検討可だが、既存コードの重複容認スタイルに合わせて今回は最小差分で対応）
- 同じ「グリッド/バッジ側はサブタスク込み・一覧側の一部ロジックはサブタスク除外」というズレが
  他の一括操作（`bulk-edit`各種、note側の`note-bulk-sel-all`等）にも潜在していないかは
  未調査（今回の報告範囲外のため）

## 🆕 iPadでタスク詳細フッター（完了/…/×ボタン）が画面下に隠れる不具合を修正（2026-07-24）

### 依頼内容

iPadでタスクを開くと、右下にあるはずの「完了」「…」「×」ボタン（`.mob-action-bar`。
PC/モバイル問わず全画面幅で共通して使われている、タスク詳細フッターの実体）が見えず、
操作できない。PCブラウザ（Chrome/Edge等）では問題なし。

### 原因

1. **`.layout{height:100vh;overflow:hidden}`（index.html 50行目付近）**
   `.layout`はページ全体の外枠で、自身はスクロールしない設計（スクロールは`.drawer-body`等
   内部要素が担う）。iPadのSafariは`100vh`を「アドレスバー等のブラウザUIを含む・最大の
   viewport」基準で解決するため、実際に見えている領域より`.layout`の方が高くなることがある。
   `overflow:hidden`によりページ全体のスクロールもできないため、はみ出した分＝縦に並んだ
   要素の一番下（タスク詳細フッター）がそのまま画面外に隠れてしまっていた。
   同じ問題が`@media(max-width:768px)`側の`.layout`/`.main`にもあった（474〜475行目付近）。
2. **`.mob-action-bar`のセーフエリア対応が`max-width:768px`のメディアクエリ内のみだった**
   （301行目付近）。ホームボタンなしiPad（iPad Pro/Air/mini 6以降のFace ID機）は
   ポートレート幅が768pxを超えることが多く（810〜834px等）、このメディアクエリの対象外。
   画面下部のホームインジケーター分の余白（`env(safe-area-inset-bottom)`）が加算されず、
   ボタンがインジケーターに近すぎる／隠れ気味になっていた。

再現条件の一致点：PCブラウザは`100vh`が常に実際の表示領域と一致し、動的に伸縮する
ブラウザUIも持たないため症状が出ない。iPad Safari固有の挙動が原因。

### 修正内容（index.html、CSSのみ4箇所）

- `.layout`（ベース・`max-width:768px`内の2箇所）と`.main`（`max-width:768px`内）に
  `height:100dvh`を追加指定（`100vh`の直後に併記し、対応ブラウザではdvhを優先させるだけの
  安全なフォールバック方式。100dvh未対応ブラウザでは従来通り100vhのまま）
- `.mob-action-bar`のベースルールに`padding-bottom:calc(6px + env(safe-area-inset-bottom))`
  を移動（全画面幅で常時有効に。`env()`は非対応環境では0として扱われるため、PC/Android等
  他環境への影響なし）。`max-width:768px`側の既存の上書き（7px版）はそのまま温存

### 動作確認

- Node.js構文チェック：3インラインscriptブロックともJS_OK
- ローカル静的サーバー＋ローカルシード済みタスクで、iPad Pro 11"相当（834×1194、
  ヘッダレス/デスクトップ幅コードパス側）でタスク詳細を開き、`.mob-action-bar`の
  `getBoundingClientRect()`が`window.innerHeight`とちょうど一致（下端が画面外に
  はみ出していない）ことを確認
- 使用したブラウザ環境はChromium系のため、Safari固有の「アドレスバー分だけ100vhが
  実視認領域より大きくなる」挙動そのものは再現できていない（Chromiumの100vhは
  常に実視認領域と一致するため）。**実iPad Safari（できればFace ID機種と旧来の
  ホームボタン機種の両方、Safariブラウザ表示・ホーム画面追加PWA表示の両方）での
  最終確認を推奨**

### セキュリティチェックの判定

- CSSのみの変更（`height`指定の追加併記、`padding-bottom`の適用範囲拡大）。
  認証・決済（Stripe）・DBスキーマ・RLS・個人情報の扱いには一切触れていない
  （セキュリティチェック対象外）

### 触れなかった箇所

- `.expand-modal{max-height:92vh}`（拡大表示モーダル、612行目付近）は今回のスコープ外
  （ユーザーが遭遇したのは通常のサイドドロワー表示）。同種のvh起因の問題を将来
  拡大表示モーダルで踏んだ場合は、同じ`92vh`→`92dvh`併記パターンが使える
- `@media(max-width:768px)`内の`.drawer{position:fixed;...;bottom:0}`（iPhone等の
  全画面ドロワー）は、iOS Safariが`position:fixed`要素については既にvisual viewport
  基準で解決するよう対応済みのため未変更

---

## 🆕 タスク詳細UIを再構成：優先度サイクルボタン＋タグをタイトル直下へ、繰り返し設定をスケジュールへ統合、詳細設定エリアを廃止（2026-07-18）

### 依頼内容・背景

タグの「つけ忘れ」が多発していた。原因はタグ設定がアコーディオン（詳細設定）の中に隠れていて視認性が低かったこと。タグは実質カテゴリとして単一選択で使われているため、目立つ場所に出す方針にした。

### 変更内容

1. **優先度：4ボタングリッド → タップで循環する1ボタンに変更**
   - 循環順：なし→高→中→低→なし（`index.html`内 `else if(a==='pri-cycle')`ハンドラで実装。既存の`pri`ハンドラ（値を直接指定する旧4ボタン用）はそのまま残置・現状未使用）
   - ボタンは`.pri-cycle-btn`（CSSで`data-p`属性値ごとに背景色分け。`--p1`/`--p2`/`--p3`変数を流用、「なし」は無色）
   - 「なし」から1タップで最も使用頻度が高いはずの「高」に到達するよう順序を設計（優先度は変更頻度が低い前提で、多くても3タップで一周する設計）

2. **タグ：詳細設定アコーディオン内 → タイトル直下、優先度ボタンの右に横並び配置**
   - 表示・トグル機構自体は変更なし（`tog-tag`ハンドラ、単一選択ロジックそのまま）。置き場所のみ変更
   - タグが0件の場合は「タグなし」というプレースホルダーテキストを表示

3. **繰り返し設定：詳細設定アコーディオン内 → スケジュール（🗓）アコーディオン内に統合**
   - 繰り返し設定時、スケジュールのヘッダーに「繰り返し」バッジを表示するよう追加（旧・詳細設定ヘッダーにあった動的バッジ表示を踏襲）

4. **詳細設定エリア（`dt-detail-block`）を完全に削除**
   - 対応するアコーディオン開閉ハンドラ（`dt-detail-toggle`）も削除
   - 中身（タグ・繰り返し）は上記1〜3の通りそれぞれ移設済みのため、情報の欠落なし

### 影響範囲・セキュリティチェック

- **DBスキーマ・RLS・認証・決済**：一切変更なし。UIレイアウトの並び替えのみ
- **データ保存ロジック**：`task.priority` / `task.tagIds` / `task.repeatRule`の保存経路・`saveTask()`は無変更。既存の値・既存タスクへの影響なし
- **触れていない箇所**：タグの単一選択ロジック、繰り返しルールの計算処理、プロジェクト/担当者選択UI（表示位置は同じまま、優先度ブロックが上に抜けた分だけ詰まった）

### 既知の注意点（次にさわる人向け）

- `.pri-grid` / `.pbtn[data-p="N"].on`のCSSは旧4ボタングリッド用で、現状未使用のまま残置（削除しても影響なし、要らなければ整理してよい）
- 優先度サイクルは「1タップで任意の値に飛べない」トレードオフを許容する設計判断（詳細は本セッションの会話ログ・設計方針を参照）。もし将来「特定の優先度に一発で飛びたい」という要望が出たら、長押しで4択ポップオーバーを出すなどの拡張を検討

---

## 🆕 PCビューでメモ入力後にタスク詳細エリアが真っ白になる不具合を修正（2026-07-16）

### 依頼内容

PCビューでタスク詳細のメモを入力し終わったとたん、タスク詳細のエリアが真っ白になる。

### 原因（3つの既存挙動の組み合わせ）

1. **`S.noteOpen`の残留**：NOTE詳細を一度でも開くと`S.noteOpen=true`になるが、
   タスク系ビュー（Next/Today等）へ移動してもこのフラグはリセットされない
   （タスクを開く`sel`/`sel-edit`等のハンドラも`S.noteOpen`を触らない）
2. **renderContent()の無条件クローズ処理**：`renderContent()`冒頭付近（index.html 4943行目〜）に
   「notes・search以外のビューではnoteドロワーを閉じる」処理があり、`S.noteOpen`が
   残留していると**タスク詳細を表示中のドロワーまで`display:none`にしていた**。
   しかも`renderDrawer()`が後続で呼ばれる前提のコードで、mainの`maxWidth`
   （PCでドロワー分だけ本文を狭める設定）はリセットしない
3. **メモ自動保存はrenderContent()単独呼び出し**：メモ入力後にフォーカスを外すと、
   400msデバウンスの自動保存（`renderDrawer()`内の`autosave`）が
   `renderSidebar();renderContent();`だけを呼ぶ（入力保護のため意図的に
   `renderDrawer()`は呼ばない設計）。このため②で消えたドロワーが復活せず、
   mainの`maxWidth`だけ残って**画面右側にドロワー幅336pxの真っ白な帯**が出る

再現条件：PC（幅769px以上）で、同一セッション中に一度でもNOTE詳細を開いた後、
タスク詳細でメモを入力し、入力後400ms以内にドロワー外へフォーカスを移す。
（コメント送信・削除など`renderContent()`を単独で呼ぶ他の操作でも同様に発生し得た）

### 修正内容（index.html 4943行目付近、1箇所のみ）

renderContent側のnoteドロワークローズ処理を修正：
- **タスク詳細ドロワーが開いているべき状態（`S.drawerOpen && S.taskId`）では隠さない**
- 実際に隠す場合は`main.style.maxWidth`もリセットする（白帯の再発防止。
  noteOpen残留中にタスク詳細を✕で閉じた場合も従来は白帯が出ていたが、これも直った）
- `#content`のoverflow復元は従来通り実行

`S.noteOpen`残留自体は温存した（notesビューに戻ると開いていたノートが再表示される
既存挙動を壊さないため）。

### 動作確認（ローカル静的サーバー＋ダミーデータ注入で実施）

- Node.js構文チェック：3インラインscriptブロックともJS_OK
- 再現テスト：noteOpen残留状態でメモ入力→blur→自動保存後もドロワーが表示されたまま
  （修正前は`display:none`＋maxWidth残留を再現・確認済み）、メモも正常に保存される
- リグレッション：
  - noteOpenなしの通常のメモ入力→自動保存：従来通り正常
  - noteOpen残留中にタスク詳細を✕で閉じる：ドロワー非表示＋maxWidthリセット（白帯なし）
  - notesビューでノート表示→タスクビューへ→notesビューに戻る：ノート再表示（既存挙動維持）
- コンソールエラーなし
- 実ログイン環境（本番）での最終確認は未実施。次にこのファイルを触る人は、
  本番で「NOTEを開く→タスクのメモを入力→すぐ外をクリック」で白帯が出ないことを確認してほしい

### セキュリティチェックの判定

- UIの描画制御のみの変更。認証・決済（Stripe）・DBスキーマ・RLS・個人情報の扱いには
  一切触れていない（セキュリティチェック対象外）

### 触れなかった箇所

- `S.noteOpen`のライフサイクル設計（タスクを開いた時にリセットする案は、
  notesビュー往復時のノート再表示挙動が変わるため見送り）
- `renderDrawer()`早期return部（6461行目付近）の`if(!S.noteOpen)`ガードは無変更
  （render()フル呼び出しではrenderContent→renderDrawerの順で整合するため）

---

## 🆕 検索画面でタグフィルタが「見えない・解除できない」問題を修正（2026-07-15）

### 依頼内容

各画面の検索窓で検索すると、その時にかかっていたタグフィルタ（`S.filterTagIds`）が
検索結果にもそのままAND条件で効いてしまう。それ自体は意図通りの挙動だが、検索結果
画面だけを見てもフィルタがかかっていることが分からず、そこから解除する手段もないため
「なぜかヒットしない」とユーザーが混乱する、という相談。

### 設計判断

フィルタと検索の掛け合わせ（AND条件）自体はやめない。多くの場合ユーザーは「今のビュー
の中から検索したい」と思っているため、検索時に全解除するのはむしろ逆に混乱を招く
（例：「今日」ビューで絞り込んで検索したのに関係ない過去のタスクまで出てくる）。
直すべきは挙動ではなく「フィルタ状態の可視化」と「その場での解除しやすさ」。

### 調査結果（修正前の状態）

- グローバル検索（`renderSearch()` / `renderSearchResults()`、6292行目〜）には
  検索ボックスしかなく、フィルタ状態を示すUIが皆無だった
- 画面上部の共通ツールバー（`#task-filters`、`renderTaskFilters()`）自体は検索画面でも
  表示されており、フィルタ有効時は×ボタンの色が変わって解除もできたが、極小のアイコンで
  検索結果と視覚的に紐付いておらず気づきにくい
- 空状態メッセージ（`renderEmpty()` の `search` ケース）が「別のキーワードで検索して
  ください」固定で、フィルタのせいで0件でもキーワードが悪いと誤解させる文言だった
- 一方 **Notes画面の検索（`renderNoteList()`、5990行目〜）は既にこの問題を解決済み**
  だった：検索ボックス下にタグチップ列＋「N件 / 全M件」のカウント表示があり、その場で
  フィルタの視認・変更・解除ができる。今回はこのパターンをグローバル検索にも適用した

### 実装内容

**1. `renderSearchFilterBar()` を新設**（`renderSearch()` 内、検索ボックスの直下に追加）
- Notes画面と同じタグチップ列（「すべて」「タグなし」＋各タグ）を表示
- 既存の `data-a="notes-tag-chip"` ハンドラをそのまま流用（新規ハンドラ追加なし。
  `S.filterTagIds` を更新して `renderContent()` を呼ぶだけの汎用処理なので、
  Notes画面でもSearch画面でも同じ挙動になる）
- フィルタ適用中は「🏷 絞り込み中」ラベルを表示

**2. `renderSearchResults(q)` にフィルタ可視化を追加**
- 結果が1件以上ある場合、フィルタ適用中なら上部に
  「N件 / フィルタなしならM件」のカウント行を表示
- **0件かつフィルタ適用中かつキーワード自体はヒットあり**の場合、専用の空状態を表示：
  「フィルタ適用中のため0件です。『{キーワード}』自体はM件ヒットしています」＋
  ワンタップでフィルタ解除できるボタン（`data-a="notes-tag-chip" data-id=""`）
- フィルタなしで0件（純粋にキーワードが未ヒット）の場合は従来通り `renderEmpty()`
- キーワード未入力の状態でフィルタが適用中の場合も、その旨を一言添える

### 動作確認

- Node.js構文チェック：index.html内の全3インラインscriptブロックともパース成功
- 変更はUIのみ（DBスキーマ・RLS・認証・決済に一切触れていないため、セキュリティ
  チェック項目は対象外）

### 触れなかった箇所

- タスク一覧・ノート一覧など検索以外の各ビューのフィルタ挙動・ツールバー本体は無変更
- `S.filterTagIds` のデータ構造・排他選択（1タグのみ）仕様は既存のまま

---

## 🆕 入力途中のコメント・メモが「勝手なリフレッシュ」で消える不具合を修正（2026-07-15）

### 依頼内容

タスク詳細・NOTE詳細でコメントやメモを入力している途中に、リフレッシュのような挙動が
走って入力内容が消えることが多発している。リフレッシュ自体は理由があって実装されている
はずなので、その機能（同期）を壊さずに入力消失だけを直してほしい、という依頼。

### 原因（「リフレッシュのような挙動」の正体は3つ）

いずれも `loadAll()` → `render()` の全画面再描画を引き起こし、`renderDrawer()` /
`renderNoteDrawer()` が drawer の DOM を `innerHTML` で丸ごと作り直すため、
未送信のコメント（`#cm-input` / `#ncm-input`）や自動保存前のメモ
（`#dt-notes` / `#nt-body`、400〜600msのデバウンス待ち中）が消えていた。

1. **バックグラウンド同期 `_syncNow`**（Realtime無効化の代替として実装された
   120秒ポーリング＋`visibilitychange`同期）。ガードが「その瞬間に
   INPUT/TEXTAREAへフォーカスがあるか」だけだったため、スマホでアプリを
   切り替えてキーボードが閉じた直後・スクロール等でフォーカスが外れた瞬間の
   同期で入力が消えていた
2. **supabase-js v2 の `SIGNED_IN` 再発火**。タブ復帰・トークン更新時にも
   `SIGNED_IN` が再発火することがあり、そのハンドラが無条件に
   `loadAll()`→`render()` していた（ガードなし。スマホでの発生頻度が高い原因は
   おそらくこれ）
3. **再接続復旧 `waitForSBAndRecover`**（頻度は低い）

### 実装内容（同期機能は維持し、入力だけを守る3層防御）

**1. `hasUnsavedDraft()` を新設**（`render()` 直前、index.html 7690行目付近）
- 「未保存の下書きが存在するか」を判定：①INPUT/TEXTAREA/contenteditableに
  フォーカス中 ②未送信コメント（`cm-input`/`ncm-input`、拡大モーダル内の複製id含む）
  ③コメントのインライン編集中textarea ④タスク/ノートのタイトル・メモがモデル値と
  不一致（=自動保存が未確定）
- `_syncNow` のフォーカスチェックをこれに置き換え。下書きがある間は同期をスキップ
  （次回周期で自動再試行されるため同期は失われない。下書きを送信/保存すれば再開）

**2. `SIGNED_IN` ハンドラに同一ユーザーガード**（11900行目付近）
- 既にサインイン済みで同じ user.id の `SIGNED_IN` 再発火なら
  `loadAll()`+`render()` をスキップ（本物のサインイン遷移・ユーザー切替・
  招待リンクフローは従来通り動作）

**3. `renderDrawer()` / `renderNoteDrawer()` に下書きの退避→復元を実装**（保険）
- drawer要素に `_taskId` / `_noteId` を記録し、**同じタスク/ノートを開いたままの
  再描画時のみ** `innerHTML` 再構築の前に `cm-input`・`dt-notes`・`dt-title`
  （ノート側は `ncm-input`・`nt-body`・`nt-title`）の値を退避し、再構築後に復元
- 復元した値がモデルと異なる（=保存前だった）場合は `autosave(true)` /
  `schedSave()` を予約して確実にDBへ保存
- `_cmSetupInput` / `_ncmSetupInput` に、復元された下書きがある場合の
  送信ボタン活性・入力欄高さの同期処理を追加
- これにより、ガードをすり抜ける未知の `render()` 経路があっても入力は消えない

### 動作確認（ローカル静的サーバー + ブラウザで実施）

- Node.js構文チェック JS_OK
- タスク詳細：cm-input・dt-notesに入力→`render()`強制実行→**両方復元されることを確認**
  （DOMは完全に作り直されているが値が引き継がれる）
- 復元されたメモが400ms後に自動保存でモデルへ反映されることを確認
- ノート詳細：nt-body・ncm-input で同様に確認、プレビューエリアにも復元値が反映
- **別のタスクに切り替えた場合は下書きが漏れない**（cm-inputが空になる）ことを確認
- `hasUnsavedDraft()` が下書きあり=true / なし=false を正しく返すことを確認
- コンソールエラーなし
- Google OAuth未実施のため、実機（本番・PWA）でのアプリ切替→復帰シナリオの
  最終確認は次にこのファイルを触る人に要フォロー

### セキュリティチェックの判定

- `SIGNED_IN` ハンドラに触れたが、変更は「再描画・再ロードのスキップ判定」のみで、
  認証方式・セッション処理・トークン扱いは一切変更していない
- DB・RLS・決済（Stripe）・個人情報の扱いに変更なし（フロントの描画制御のみ）

### 触れなかった箇所

- `waitForSBAndRecover`（再接続復旧）の `render()` はそのまま（層3の退避→復元で保護される）
- PC拡大モーダル（`openExpandModal`）自体の再描画対策は未実装（モーダルは
  `render()` で作り直されないため影響は限定的。モーダル内の下書きは
  `hasUnsavedDraft()` の重複id走査で同期スキップ対象にはなっている）
- クイック追加バー・検索欄など、コメント/メモ以外の入力欄の下書き復元は対象外
  （フォーカス中は従来通りガードされる）

---


## 🆕 Assignedビューのバッジ件数とリスト表示件数の不一致を修正（2026-07-14）

### 報告内容
- 左メニューAssignedバッジが「4」なのにリストには3件しか表示されない
- ユーザー仮説は「MEOエージェントPJの共有解除が原因では」だったが、DB調査の結果**共有解除は無関係**

### 原因（実データで特定）
- 4件目は共有PJ「商品企画全般」内の**担当サブタスク**（parent_task_id あり）
- バッジ計算 `counts().assigned` はサブタスクも含めてカウントする一方、`renderList()` の `showSubsInView` に `assigned` が含まれておらず、サブタスクがリスト描画から除外されていた

### 修正内容（index.html）
1. `renderList()`: `showSubsInView` に `'assigned'` を追加（today/flagged/overdue と同じ扱い）。担当サブタスクがリストに表示されるように
2. `counts().assigned`: `(!S.hideNotStarted||!isNotStartedTask(x))` を追加し、「現在」フィルタON時の件数計算をTodayバッジと同条件に統一（同種の不一致の予防修正）

### 補足・触れなかった箇所
- `setProjectWorkspace(projId, null)`（共有解除）はタスクの `assignee_id` をクリアしない仕様。自分担当タスクはAssignedに残る（今回の表示上は妥当）。ただし**他メンバーのassignee_idも残留する**ため、将来的に整理を検討してもよい
- flagged / overdue のバッジも `hideNotStarted` を考慮していない同種の潜在不一致があるが、報告範囲外のため今回は未変更
- 認証・決済・個人情報には一切触れていない（セキュリティチェック対象外の変更）

---

## 🆕 タスク一覧にコメント有無の💬バッジを追加・タップで最新コメントへ遷移（2026-07-13）

### 依頼内容

タスク一覧（Next/Today/プロジェクト等、`renderRow()`が使われる全ビュー）で、コメントが
付いているタスクに💬アイコンを表示し、タップするとそのタスク詳細を開いて最新コメントが
見える位置までスクロールしてほしいという依頼。

### 実装内容

**1. コメント件数の事前集計**（`loadCommentCounts()`、`index.html` 2624行目付近）
- 従来コメントは`initComments(taskId)`でタスク詳細を開いた時にだけ遅延ロードしており
  （`S._commentCache`）、一覧側はコメントの有無を一切知らない状態だった
- 新規に`S.commentCounts`（`{taskId: 件数}`）を追加し、`loadAll()`内で
  `loadCommentCounts()`を非同期実行（本体データのロードはブロックしない）
- `task_comments`テーブルを`task_id`のみ`select`して集計。RLS
  （`task_comments: own or workspace (select)`）により自分のコメント＋共有ワークスペース内の
  コメントのみが返るため、追加のフィルタ条件は不要
- タスクが1000件超で消えた過去バグ（本ファイル内「🚨 タスクが1000件超で読み込まれず消える
  問題」参照）と同じPostgREST 1000行上限に当たらないよう、`.range()`によるページ取得を実装
  （コメント件数がいずれ1000件を超えても正しく集計される）

**2. 一覧行への💬バッジ表示**（`renderRow()`、5548行目付近）
- `S.commentCounts[task.id]`が存在する（1件以上）タスクのみ、優先度・期限などの他の
  メタ情報チップと並べて`💬 件数`ボタンを表示（`.mc`クラスの他チップと統一感のある見た目）
- `data-a="task-comment-jump"`を付与し、既存のグローバルクリック委任ハンドラに乗せる形で実装
  （行全体のクリック（`data-a="sel"`）とは`closest('[data-a]')`により独立して動作するため、
  他の`go-proj`チップ等と同様、行クリックとは競合しない）

**3. タップ時の遷移・スクロール処理**（`task-comment-jump`アクション、8018行目付近）
- 通知一覧（`db-notif-row`）のタスク遷移ロジックを踏襲し、タスク詳細drawerを開く
  （モバイルはプロジェクト/Inboxビューに遷移してからdrawerを開く）
- 既存の`scroll-to-comments`アクション（コメントセクション内の「💬 コメント」バッジから
  移動する処理、7999行目付近）と同じスクロール計算式を流用し、`#cm-section`まで
  スムーズスクロール＋背景を一瞬ハイライト
- `initComments(id)`の完了を`await`してからスクロール（コメント本体の読み込み前に
  スクロールすると、コメント欄の高さが確定しておらずズレる可能性があるため）
- コメント一覧はデフォルトで直近3件のみ表示（`_cmRenderList`の`PREVIEW=3`、既存仕様）
  かつ最新のコメントが末尾に来るため、コメントセクションが見えれば「最新コメート」も
  自然と視界に入る設計（コメント個別へのピンポイントスクロールまでは行っていない）

**4. バッジ件数のライブ更新**
- コメント送信（`_cmSend`）・削除（`_cmDelete`）時に`S.commentCounts`をその場で増減し、
  `renderContent()`を呼んで一覧側の💬バッジ数を即座に反映（次回`loadAll()`を待たない）

### 動作確認

- Node.js構文チェック済みでエラーなし
- ローカルに簡易静的サーバー（`.claude/static-server.js`、Node標準の`http`のみ使用、
  デプロイ物には含めない）を立て、`S.commentCounts`にダミー値を注入してブラウザ上で
  💬バッジの表示・クリック時のdrawer展開・`#cm-section`へのスクロールが正しく動作する
  ことを確認済み（Google OAuthログインは行っていないため、実データでのコメント本文
  表示・実機/本番環境での最終見た目確認は次にこのファイルを触る人に要フォロー）

### 触れなかった箇所

- 認証・決済（Stripe）・RLSポリシー自体は今回のスコープ外で、一切変更していない
  （`task_comments`の既存RLSをそのまま利用しただけ）
- コメント個別（特定の1件）へのピンポイントスクロール・ハイライトは行っていない
  （セクション全体へのスクロールに留めている。要望があれば`cm-list`内の最後の`.cm-item`
  要素を個別に`scrollIntoView`する拡張が可能）
- ノート詳細側のコメント（`ncm-section`）・ノート一覧への同様のバッジ表示は対象外

---

## 🆕 一括処理・タスク単体メニューに「プロジェクト最上部へ移動」ボタン追加（2026-07-11）

### 背景

タスクが20件を超えるようなプロジェクトで、ドラッグ&ドロップによる並べ替えだと
最下部から最上部への移動に大きな操作コストがかかっていた（ドラッグ距離がリスト長に
比例して増える）。

### 実装内容

**1. 一括処理ツールバー**（`S.selectMode`時のツールバー、field='top'）
- プロジェクトビュー（`S.view==='project'&&S.projId`）でのみ「⬆️ 最上部へ」ボタンを表示
- 選択したタスクをプロジェクトごとにグルーピングし、各グループ内で**現在のorder値の昇順
  （＝表示順）を基準に相対順序を維持したまま**、まとめて先頭（既存タスクより小さいorder値）
  に積み直す（案B方式）
- projectId未設定のタスク（Inbox等）は対象外としてスキップ

**2. タスク詳細「•••」メニュー**（action='move-to-top'）
- タスクがプロジェクトに属している場合のみメニュー項目を表示
- 単体タスクを即座にプロジェクト最上部（`topOrderInProject()`が返す値）へ移動

### 実装場所
- `topOrderInProject(projId)`関数（既存、プロジェクト内最上部sort_orderを返す）を再利用
- `handleBulkEdit(field)`内に`field==='top'`分岐を追加
- ツールバーHTML生成部分（一括処理ボタン群）に条件付きでボタン追加
- タスク詳細drawerの`•••`メニュー項目配列と、`handleAction`内の`a==='move-to-top'`分岐を追加

### 触れなかった箇所
- 認証・決済・個人情報には無関係な変更のため、セキュリティチェック項目は対象外と判断
- Next view等、order（手動並び替え）を使わないビューには本機能を表示していない
  （元々`並び替え`ボタン自体もNext viewでは非表示のため、整合性を保った）

---

## 🆕 Supabaseセキュリティアラート対応：管理者用RPC・RLSポリシーの権限漏れを修正（2026-07-10）

### 背景

Supabaseから「Action required: security vulnerabilities detected in your projects」という
セキュリティアラートメールが届き、`get_advisors`（security）で全体を棚卸しした結果、
共有Supabaseプロジェクト（`sfhtvtcmgueystyuhzvd`）内のTaskra関連テーブル・関数に、
「管理者専用／service専用のつもりが実際は誰でも（anon含む）実行・アクセス可能だった」
権限設定ミスが複数見つかった。

### 修正内容

**1. `admin_get_all_users()` RPCに認可チェック追加＋anon実行権限を剥奪**
（マイグレーション: `fix_admin_get_all_users_auth_check`）

- Tavera側の関数だが、同一プロジェクト内の問題として合わせて対応
- `admin_update_plan` / `admin_set_usage_overrides` / `admin_reset_usage` の3関数には
  `IF (SELECT email FROM auth.users WHERE id = auth.uid()) IS DISTINCT FROM 'mstd0520@gmail.com' THEN RAISE EXCEPTION`
  という認可チェックが入っていたが、`admin_get_all_users()`だけこのチェックが欠落しており、
  かつ`anon`ロールにもEXECUTE権限が付与されたままだった
- 未ログインの第三者が`/rest/v1/rpc/admin_get_all_users`を直接叩くだけで、
  Taveraの全ユーザーのメールアドレス・プラン・利用状況が取得できる状態だった（SECURITY DEFINERのためRLSも無視）
- 対応: 同関数に同じ認可チェックを追加し、4関数すべて`anon`からのEXECUTE権限を`REVOKE`
  （`authenticated`のみ残すが、内部チェックで結局本人以外は`Unauthorized`になる）

**2. `ai_usage` / `file_extract_usage` テーブルのRLSポリシーを管理者限定に修正**
（マイグレーション: `restrict_overly_permissive_rls_policies`）

- `"Admin can read all usage"` / `"Admin can update usage"` という名前のポリシーが、
  実際には`USING (true)`かつロール指定なし（`public`扱い）＝**anon含め誰でも
  全ユーザーのAI利用状況・ファイル抽出利用状況を読み書きできる状態**だった
- 対応: `USING`句を`(SELECT email FROM auth.users WHERE id = auth.uid()) = 'mstd0520@gmail.com'`に変更

**3. `line_users` テーブルのポリシーを`service_role`限定に修正**

- ポリシー名`"line_users: service only"`という意図に反し、`USING(true)`が`public`ロールに
  適用されており、LINE連携ユーザーのマッピング情報を誰でも読み書き削除できる状態だった
- 対応: ポリシーを`TO service_role`に変更（クライアントからは触れなくなる。
  Edge Functionはservice_roleキー使用のため影響なし想定）

**4. `task_logs` テーブルの全ポリシーから`anon`を除外**

- `read_all` / `insert_all` / `update_all` / `delete_all` の4ポリシーが全て`USING(true)`かつ
  `public`ロールで、未ログインでも全タスクログの閲覧・改ざん・削除が可能だった
- 対応: 4ポリシーとも`TO authenticated`に変更（ログイン済みユーザーのみ。個別ユーザー単位の
  絞り込みは今回未実施＝ログインさえすれば他人のログも操作可能なまま。要フォロー）

**5. `workspace_members` テーブルの無条件許可ポリシーを削除**

- `ws_members_insert`（`WITH CHECK (true)`, 無条件許可）と、正しく本人チェックする
  `wsmembers_can_insert_self`（`WITH CHECK (user_id = auth.uid())`）が同居しており、
  RLSはOR評価のため前者が後者を無意味化し、誰でも任意のワークスペースに自分以外を
  メンバー追加できる状態だった
- 対応: 無条件許可の`ws_members_insert`を削除。正しい制限付きポリシーのみ残す

**6. `notifications` テーブルのINSERT/DELETEから`anon`を除外**

- SELECT/UPDATEは本人限定で正しかったが、INSERT/DELETEが`USING(true)`かつ`public`で
  誰でも任意ユーザー宛の通知を作成・削除できた
- 対応: `TO authenticated`に変更

### 原因調査

- `file_extract_usage`のポリシーは`create_file_extract_usage`マイグレーション（2026-07-05）で
  `ai_usage`テーブルの既存ポリシー（ポリシー名・`USING(true)`の書き方まで同一）を
  そのままコピーして作られたことが履歴から確認できた。つまり「`ai_usage`側の誤った
  権限設計」が起点となり、新規テーブルを作るたびにコピペで踏襲・拡散していったと見られる
- `ai_usage` / `line_users` / `task_logs` / `workspace_members`自体は、追跡可能な
  マイグレーション履歴（2026-06-27以降）より前に作成されたテーブルのため、
  最初にいつ・どの改修で`USING(true)`パターンが持ち込まれたかは特定できなかった
- 教訓: `USING (true)`は「誰でもOK」という意味であり、「管理者/service専用」を
  意図する場合は`TO service_role`や`auth.uid()`ベースのチェックを明示する必要がある。
  新規テーブル作成時に既存ポリシーをコピーする前に、対象ロールが本当に適切か確認すること

### 触れなかった箇所（要フォロー）

- `task_logs`の4ポリシーは`authenticated`なら誰でも全ログを操作できる状態のまま
  （ユーザー/ワークスペース単位の絞り込みは未実装）
- 以下のSupabase Advisor（security）指摘は今回スコープ外、未対応:
  - 12テーブル（`kotobakake_*`, `reno_*`, `housecleaning_*`など）でRLS有効だがポリシー0件
    （Edge Function経由のservice_roleアクセスのみを想定した設計と思われ、リスクは低いと
    判断したが未検証）
  - `pg_net`拡張がpublicスキーマに配置されている（`extension_in_public`）
  - 認証関連のヘルパー関数（`auth_user_workspace_ids`, `find_household_by_code`,
    `get_my_household_id`, `get_workspace_by_invite_token`, `household_has_premium`）が
    `anon`/`authenticated`双方からSECURITY DEFINERとして実行可能（意図的な設計の可能性が
    高いが未レビュー）
  - 複数関数の`function_search_path_mutable`警告（`purge_old_notification_log`など）
  - 漏洩パスワード保護（HaveIBeenPwned連携）が無効

---

## 🆕 一括日付設定に「本日」ボタン追加／日付・時間調整ボタンの視認性改善（2026-07-10）

### 依頼内容

1. タスク一覧の「日付を一括設定」モーダルで、開始日・期限それぞれの「+1日」ボタンの
   左に「本日」ボタンが欲しい
2. タスク詳細・一括編集モーダル両方にある日付/時間調整ボタン（`.date-adj-btn`：
   +1日／+7日／+1月／+10m／+1h／+3h／9:00等の時刻ボタン／本日）が小さくて見づらいが、
   サイズは変えられないので、メモ欄の補助ボタン（`.note-copy-btn`）のように
   縁と文字色で視認性を上げてほしい

### 変更内容

**1. 一括日付設定モーダルに「本日」ボタン追加**（`handleBulkEdit('dates')`内、
index.html 7400行台）
- 開始日・期限それぞれのボタン行の先頭（+1日の左）に「本日」ボタンを追加
  （id: `bulk-sadj-today` / `bulk-dadj-today`）
- 新規ヘルパー関数`setBulkToday(inp,wdEl)`を追加。既存の`adjBulkDate`は
  「現在値がある場合はそこからの差分計算」ロジックのため日数0では素通りしてしまい
  「常に今日にする」用途には使えなかったので、専用関数として分離
- クリック時は`startCleared`/`dueCleared`フラグをfalseに戻す（クリア状態から
  本日ボタンで復帰できるように）

**2. `.date-adj-btn`の視認性改善**（CSS、index.html 195行目・213行目）
- 変更前: `background:var(--bg2)` `border:1px solid var(--border)` `color:var(--text2)`
  （グレー系で薄い）
- 変更後: `background:transparent` `border:1px solid var(--accent)` `color:var(--accent)`
  `font-weight:700`を追加。hoverは`background:var(--accent-bg,var(--bg2))`に変更
- サイズ（font-size:10px, padding:6px 0）は指示通り変更なし
- `.date-adj-btn`は共通クラスのため、タスク詳細のスケジュール欄（開始日/開始時間/期限/
  計画開始日）と一括編集モーダルの両方に自動的に反映される

### 触れなかった箇所

- 認証・決済（Stripe）・RLS・DBスキーマは今回のスコープ外で、一切変更していない
  （UI/CSSのみの変更のため、セキュリティチェック項目は非該当と判断）
- ダークモード（`[data-dark]`）側で`--accent`の再定義はないため、ライト/ダーク共通で
  同じインディゴ系の色になる。ダーク背景での実機コントラスト確認は未実施
- 実機ブラウザでの最終見た目確認は未実施。特に一括編集モーダルは4ボタン
  （本日/+1日/+7日/+1月）がflex:1で並ぶため、修正後の文字色・縁が窮屈に
  見えないか確認してほしい

Node.js構文チェック済みでエラーなし。push後、GitHub Pagesビルド成功を確認済み
（コミット`dedf539`でbuilt）。

---

## 🆕 PCビュー タスク詳細のメモツールバーが2段に折り返す不具合を修正（2026-07-10）

### 背景

PC版（幅336pxの右サイドドロワー`.drawer`）でタスク詳細を開き、メモ欄を開くと、
`#memo-toolbar`内の4ボタン（コピー／📅 日時／🔗 Link／編集）のうち「編集」だけが
2段目に折り返されてしまう不具合の報告（スクリーンショットで確認）。

### 原因

`.note-copy-btn`の横paddingが`14px`と大きく、4ボタン+アイコン+テキストの合計幅が
ドロワー内側の実効幅（約281px、`.drawer`336px→`.drawer-body`padding14px→
`.dt-schedule-block`border1px→`.dt-section-body`padding12px を差し引いた値）を
約20px超過していた。

### 変更内容

- `.note-copy-btn`（217行目付近）の横paddingを`14px`→`8px`に縮小、内部アイコン-テキスト間の
  `gap`を`4px`→`3px`に縮小、`white-space:nowrap`を追加（折り返し防止の保険）
- このクラスは以下4箇所で共通利用されているため、今回の修正は全箇所に反映される：
  - タスク詳細メモ（コピー／日時／Link／編集）
  - タスク詳細コメント（日時／Link）
  - ノート詳細メモ（コピー／日時／Link／プレビュー）
  - ノート詳細コメント（日時／Link）
- 概算計算（Noto Sans CJK JP Boldでのテキスト幅測定＋アイコン/絵文字幅の見積り）で、
  修正後の4ボタン合計幅は約252px（旧: 約301px）となり、実効幅281pxに対して
  約29pxの余裕を確保。実機/実ブラウザでの最終確認は未実施のため要目視確認
- フォントサイズ・縦paddingは変更していないため、ボタンの高さや文字の読みやすさは維持

Node.js構文チェック済みでエラーなし（CSSのみの変更、`<style>`ブロック内でJSへの影響なし）。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- モバイル（幅768px以下）では`.drawer`が画面幅100%になるため元々折り返しは発生しておらず、
  今回の変更による影響は軽微（ボタンがやや小さくなる程度）と想定
- 実際のPCブラウザでの見た目確認はできていないため、次にこのファイルを触る人（AI/人間）は
  実機で1段に収まっているか、ボタンが窮屈すぎないかを確認してほしい

---

## 🆕 コメント入力欄がキーボードに隠れる不具合を修正・追加調整（2026-07-09）

### 追加調整（初回対応だけでは不十分だったため）

初回対応（余白320px + visualViewport.resizeイベントのみでスクロール調整）では、
実機で確認したところフォーカス直後にまだ隠れが残っていた。原因として、
`visualViewport`の`resize`イベントがキーボードのアニメーション完了タイミングと
ズレる場合があると考えられたため、以下に変更：

- スペーサーの高さを320px→480pxに増量（サジェストバー分も含めて確実に余地を確保）
- `visualViewport.resize`イベントに依存せず、フォーカス時に150ms/350ms/600msの
  3タイミングで強制的にスクロール位置を再計算するフォールバック処理を追加
  （まだそのフィールドにフォーカスが残っている場合のみ実行、二重スクロールしないよう
  差分が無ければ何もしない判定込み）
- ロジック自体は1つの関数`adjustScroll`に統一し、`visualViewport.resize`とフォールバック
  タイマーの両方から呼び出す形に整理

Node.js構文チェック済みでエラーなし。実機での再確認が必要。

---

## 🆕 コメント入力欄がキーボードに隠れる不具合を修正（2026-07-09）

### 背景

タスク詳細・ノート詳細どちらも、画面下部の「コメントを追加…」欄をタップすると
キーボードが迫り上がり、入力欄自体が隠れて見えなくなる不具合の報告。

### 原因

キーボード表示時に入力欄を見える位置までスクロールする処理（`visualViewport.resize`を
使った既存ロジック、11441行目付近）はすでに存在していたが、コメント入力欄は
`.drawer-body`内の一番下（末尾）の要素のため、スクロールしようにも
「これ以上スクロールできる余地」がなく、既存ロジックが機能していなかった。

### 変更内容

- 新規IIFE（既存の`visualViewport`対策コードの直前に追加）：
  - `INPUT`/`TEXTAREA`/`contenteditable`要素にフォーカスが入った瞬間、
    最も近い`.drawer-body`（`.expand-modal`/`.calc-drawer-body`/`.tlist-wrap`も対象）の
    末尾に高さ320pxの一時的な余白div（`data-kb-spacer`）を追加し、スクロール可能な余地を確保
  - フォーカスが外れた（かつ他の入力欄にフォーカスが移っていない）タイミングで余白を削除し、
    追加前のscrollTopに復元
  - この余白があることで、既存の`visualViewport.resize`ハンドラが実際にコンテナを
    スクロールして入力欄をキーボードの上に見える位置まで移動できるようになる
- 既存のスクロール処理自体（gap:24pxなど）は変更なし

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- 実機（iOS PWA）での目視確認が必要。挙動が想定と異なる場合は320pxの余白量や
  gap値の調整、または`scrollIntoView`ベースの別アプローチへの切り替えを検討

---

## 🆕 メモ/コメントの全ボタンを塗りつぶしなし(アウトライン)に統一、編集/プレビューも同デザインに（2026-07-09）

### 背景

前回、コピー・日時・Linkを塗りつぶし（`background:var(--accent)`）で統一したが、実機で見ると
派手すぎる／編集(タスク詳細)・プレビュー(ノート詳細)ボタンだけデザインが違うとの指摘。
「全部塗りつぶしなしにして」「編集ボタンもデザイン合わせて」という依頼。

### 変更内容

- `.note-copy-btn`を塗りつぶし→アウトラインに変更：
  `background:var(--accent)`/`color:#fff` → `background:transparent`/`color:var(--accent)`、
  `border:1px solid var(--accent)`は維持。hoverは`background:var(--accent-bg,var(--bg2))`
- 「編集」（タスク詳細 `dt-preview-btn`）と「プレビュー」（ノート詳細 `nt-preview-btn`）を
  `.note-stamp-btn-minor`→`.note-copy-btn`に変更し、他の3ボタン（コピー／日時／Link）と
  完全に同一デザインに統一
- これにより以下4箇所の全ボタンが同一デザイン（アウトライン・同色・同サイズ）になった：
  - ノート詳細メモ：コピー／📅 日時／🔗 Link／プレビュー
  - ノート詳細コメント：📅 日時／🔗 Link
  - タスク詳細メモ：コピー／📅 日時／🔗 Link／編集
  - タスク詳細コメント：📅 日時／🔗 Link
- 使わなくなった`.note-stamp-btn-minor`のCSS定義を削除（他に参照箇所なし、確認済み）
- イベントハンドラ（`data-a`/`id`）は一切変更しておらず、見た目のみの変更

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- PC拡大モーダル（`openExpandModal`）は`#drawer`の`innerHTML`をコピーする実装のため、
  今回のクラス変更は自動的に反映される想定（別途モーダル側の個別修正は不要）

---

## 🆕 メモ/コメントの日時・Link・コピーボタンを完全統一（2026-07-09）

### 背景

前回の対応で「日時」ボタンだけコピーと同じ大きさ（塗りつぶし）にしたが、実機で見ると
「日時」「Link」「コピー」がそれぞれ違うデザイン（塗りつぶし/アウトライン/地味）のままで
統一感がないとの指摘。加えて、タスク詳細・ノート詳細それぞれの「コメント」欄にある
「📅 日時」「🔗 Link」ボタンも従来の旧`.note-stamp-btn`（グレーのボーダー付きピル）のまま
放置されていたため、これも合わせて統一してほしいとの依頼。

### 変更内容

- `.note-copy-btn`を全ボタン共通の統一スタイルとして再定義し、サイズをコンパクト化：
  `padding:10px 16px`→`6px 14px`、`min-height:44px`→`28px`、`font-size:13px`→`12px`、
  `border-radius:10px`→`8px`。1行に複数ボタンを並べても折り返さないよう調整
- 使わなくなった`.note-stamp-btn-major`（アウトラインの中間サイズ）は削除
- 以下すべてのボタンを`.note-copy-btn`（塗りつぶし・同色・同サイズ）に統一：
  - ノート詳細メモ：コピー／📅 日時／🔗 Link（プレビューは`.note-stamp-btn-minor`のまま維持）
  - ノート詳細コメント：📅 日時（`ncm-stamp`）／🔗 Link（`ncm-link-btn`）
  - タスク詳細メモ：コピー（`copy-task-notes`）／📅 日時（`stamp`）／🔗 Link（`dt-link-btn`）
    （編集トグル`dt-preview-btn`は`.note-stamp-btn-minor`のまま維持）
  - タスク詳細コメント：📅 日時（`cm-stamp`）／🔗 Link（`cm-link-btn`）
- イベントハンドラ（`data-a`/`id`）は一切変更しておらず、見た目のみの変更

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- 「編集」「プレビュー」トグルボタンは意図的に脇役スタイル（`.note-stamp-btn-minor`）のまま
  維持（今回の統一対象は日時・Link・コピーの3種）
- PC拡大モーダル（`openExpandModal`）は`#drawer`の`innerHTML`をコピーする実装のため、
  今回のクラス変更は自動的に反映される想定（別途モーダル側の個別修正は不要）

---

## 🆕 メモツールバーのサイズ調整・Note/タスク詳細デザイン統一（2026-07-09）

### 背景

直前の「ノート詳細画面『メモ』ツールバーのボタン階層改善」で`.note-copy-btn`（コピー、塗りつぶし）
を大きくしたところ「縦に大きすぎる」というフィードバック。また、タスク詳細側の同種メモツールバー
（`memo-toolbar`、絵文字アイコンのみの旧`.note-stamp-btn`スタイル）とノート詳細側のデザインが
異なりすぎるため統一してほしいとの要望があった。

### 変更内容

- `.note-copy-btn`：縦幅を約2/3に縮小（`padding:10px 16px`→`7px 16px`、`min-height:44px`→`30px`）。
  横幅（`padding`の左右16px）は変更なし
- 新規CSSクラス`.note-stamp-btn-major`を追加：「📅 日時」ボタン用。`.note-copy-btn`と同じ
  padding/min-height/font-sizeだが、塗りつぶしではなくアウトライン（背景transparent、
  `border:1px solid var(--accent)`、文字色`var(--accent)`）でコピーボタンとの主従を視覚的に区別
- ノート詳細（`renderNoteDrawer`内）の「📅 日時」ボタンを`.note-stamp-btn-minor`→
  `.note-stamp-btn-major`に変更（コピーボタンと同じ大きさに）
- タスク詳細（`renderDrawer`内、`#memo-toolbar`）を全面的にNote側と同じデザイン言語に統一：
  - 📋（絵文字のみ）→ `.note-copy-btn`（SVGアイコン+「コピー」テキスト、`data-a="copy-task-notes"`）
  - 📅（絵文字のみ）→ `.note-stamp-btn-major`（「📅 日時」テキスト付き）
  - 🔗（絵文字のみ）→ `.note-stamp-btn-minor`（「🔗 Link」テキスト付き）
  - 編集（旧: インラインstyleで塗りつぶし）→ `.note-stamp-btn-minor`（インラインstyle除去、
    ノート詳細の「プレビュー」ボタンと同格の脇役スタイルに統一）
  - `#memo-toolbar`に`flex-wrap:wrap`を追加（ボタンサイズ拡大に伴う折り返し対応）
- イベントハンドラ（`data-a="copy-task-notes"`、`id="dt-link-btn"`、`id="dt-preview-btn"`等）は
  一切変更しておらず、見た目のみの変更

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- コメント欄（`cm-section`内）の「📅 日時」「🔗 Link」ボタン（`.note-stamp-btn`のまま、
  `ncm-stamp`/`ncm-link-btn`）は今回のスコープ外で未変更
- PC拡大モーダル（`openExpandModal`）は`#drawer`の`innerHTML`をコピーする実装のため、
  今回のクラス変更は自動的に反映される想定（別途モーダル側の個別修正は不要）

---

## 🆕 ノート詳細画面「メモ」ツールバーのボタン階層改善（2026-07-09）

### 背景

ノート詳細（`#drawer`内）の「メモ」ツールバーで、「📅 日時」「コピー」「Link」「プレビュー」の
4ボタンが同一スタイル（`.note-stamp-btn`）で並んでおり、実際に最も多用される「コピー」が他と
埋もれて視認・タップしづらいという声への対応。

### 変更内容

- 新規CSSクラスを追加（既存`.note-stamp-btn`はそのまま温存、他画面への影響なし）：
  - `.note-copy-btn`：コピー専用。塗りつぶし（`var(--accent)`背景+白文字）、アイコン+テキスト、
    `min-height:44px`でタップ領域確保、`:active`で`scale(0.96)`の押下フィードバック
  - `.note-stamp-btn-minor`：日時・Link・プレビュー用。ボーダーレス・グレー文字で脇役化
- ノート詳細のメモツールバーHTML（`index.html`内、ノートdrawer描画部分）を上記クラスに置き換え。
  コピー音ボタンにSVGアイコン（クリップボード）を追加
- 挙動・イベントハンドラ（`data-a="copy-note-body-inline"`、`id="nt-link-btn"`、`id="nt-preview-btn"`等）は
  一切変更しておらず、見た目のみの変更

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- タスク詳細側の同種メモツールバー（`copy-task-notes`等、絵文字アイコンのみの旧スタイル）は
  今回のスコープ外で未変更。同じ考え方を展開する場合は`.note-copy-btn`/`.note-stamp-btn-minor`を
  流用可能
- PC拡大モーダル（`openExpandModal`）は`#drawer`の`innerHTML`をコピーする実装のため、
  今回のクラス変更は自動的に反映される想定（別途モーダル側の個別修正は不要）

Node.js構文チェック済みでエラーなし。

---

## 🆕 PC拡大モーダル（openExpandModal）内でメモ・各セクション開閉が効かない不具合・修正（2026-07-08）

### 症状

タスク詳細をPCで「拡大表示」（`openExpandModal('task')`で開く大きいモーダル）した状態で、
モーダル内の「メモ」セクションをタップしても開閉せず、代わりに背後にある元のドロワー（右側の
タスク詳細パネル）側のメモが開閉してしまう。同様に📅（日時スタンプ）ボタンでメモに日時を挿入
しても、見た目上は反映されない（実際は背後のドロワーのテキストエリアに挿入されていた）。

### 原因

`openExpandModal()`は`renderDrawer()`が生成した`#drawer`のDOMを`modal.innerHTML = dr.innerHTML`で
**そのままコピー**して拡大モーダルを作る実装のため、`memo-collapse`・`dt-notes`・`dt-detail-body`
など多数の`id`が**ページ内に重複**する（元のドロワーと拡大モーダルの両方に同じidの要素が存在）。

一方、セクション開閉やメモ操作系の一部のクリックハンドラ（グローバルな`data-a`委任クリックハンドラ内）
は`document.getElementById('memo-collapse')`のように**ドキュメント全体から検索**していたため、
常に「そのidを持つ最初の要素」＝元のドロワー側の要素を掴んでしまい、拡大モーダル側でクリックしても
背後のドロワーが操作される、という不具合になっていた。

なお`date-adj`/`date-clear`/`paste-to-field`/`clear-note-body`など一部のハンドラは既に
`el.closest('.expand-modal,#drawer')`でスコープを絞ってから要素を取得する対策が入っていたが、
下記のメモ・セクション開閉系のハンドラには**同じ対策が漏れていた**。

### 修正内容

以下のハンドラを、クリックされた要素の属する`.expand-modal`または`#drawer`にスコープを絞って
要素を取得するよう統一（`el.closest('.expand-modal,#drawer')`→`ctx.querySelector(...)`→
見つからなければ`document.getElementById(...)`にフォールバック、という既存パターンに合わせた）：

- `dt-memo-toggle`（メモ開閉）
- `dt-detail-toggle`（詳細設定開閉）
- `dt-subs-toggle`（サブタスク開閉）
- `dt-cm-toggle`（コメント開閉）
- `dt-sched-toggle`（スケジュール開閉）
- `dt-gantt-toggle`（未使用だが同様に対策）
- `subs-done-toggle`（完了済みサブタスク表示）
- `stamp`（📅 日時スタンプ挿入ボタン）
- `copy-task-notes`（メモをコピー）
- `clear-task-notes`（メモをクリア）

また、`reattachModalEvents()`（拡大モーダル用の再イベントアタッチ関数）内で従来アタッチされて
いなかった以下も追加：
- `#dt-link-btn`（🔗 リンク挿入ボタン）
- `#memo-expand-btn` / `#memo-collapse-btn`（メモの「もっと見る／閉じる」）

これにより、拡大モーダルを開いた状態でも、モーダル自身の要素に対して正しく操作できるようになった
（背後のドロワーが誤って操作されることがなくなった）。

### 副次対応：メモ欄の高さを拡大（2026-07-08）

タスク詳細のメモ入力欄（`#dt-notes`のtextarea）・プレビューエリア（`#dt-preview-area`）の高さを
約2倍に拡大：
- textarea: `rows="6"` → `rows="12"`
- プレビューエリア: `max-height:160px` → `max-height:320px`（「もっと見る」判定の閾値も164→324に追随）

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- `dt-gantt-toggle`に対応するマークアップは現状コード内に見当たらず（過去機能の残骸と思われる）。
  動作確認はできないが、他の開閉ハンドラと同じ対策のみ機械的に適用した

---

## 🆕 「メール・チャットから起票」機能を追加（2026-07-05）

### 背景・設計思想

Nextビュー（GTDのNext Action）とDashboardで整理はしているが、Teams・メール・口頭依頼が
飛び交って捕捉しきれず集中を乱される、という課題への対応。「AIに優先順位を決めさせる」案も
出たが、優先度判断には人にしか分からない文脈（誰が待っているか・口頭の重み等）が要るため
却下。GTDのCapture→Clarifyのうち、Clarify前段の**Captureの摩擦を減らす**ことに絞った：

- 貼り付けたテキストからAIが行動項目だけを抽出する
- ただし**自動でタスク化はしない**。既存のAIチャット（`add_task`等）は「即実行」の設計だが、
  雑多な文章からの抽出は誤爆のコストが高いため、候補をチェックボックス付きで提示し、人が
  選別してから確定させる「下書き→確認→確定」のフローにした
- 確定した項目は`status:'inbox'`でInboxに入れるのみ。プロジェクト・タグ付けやNextへの
  昇格判断は今まで通り人間が行う（AIに意思決定させない）

### 実装

- エントリポイント: AIチャットパネルのヘッダーに📋ボタンを追加（`data-a="extract-open"`）。
  既存のAIチャット（即実行コマンド用）とは別の専用モーダルとして実装し、責務を分離
- `openExtractModal()`: 貼り付け用テキストエリアのモーダルを表示
- `extractAnalyze()`: 既存の`AI_ENDPOINT`（`ai-chat` Edge Function、変更なし）に対し、
  専用のsystem prompt + `extract_tasks`ツール（`tool_choice`で強制）を渡して呼び出す。
  Edge Function自体はsystem/messages/toolsをそのまま中継する汎用プロキシなので
  **バックエンドの変更・デプロイ不要**で実現できた
- `renderExtractResults()` / `extractConfirm()`: 抽出結果を選択・タイトル編集・期限日編集
  可能なカードとして表示し、選択した件数分だけ`mkTask()`→`saveTask()`でInboxに追加
- 既存のAI機能と同様、Freeプランでは`showUpgradeModal('ai')`でゲート。月間AI利用回数の
  上限もEdge Function側の既存カウンターがそのまま適用される

Node.js構文チェック済みでエラーなし。

---

## 🆕 一括処理モードが完了後も終了しない問題・修正（2026-07-05）

### 症状

一括処理モード（「一括」ボタン）で日付・タグ・プロジェクト・繰り返し・フラグを
一括設定すると、操作自体は成功するが**選択モードが終了せず**、チェックボックス表示
のまま他のビューに遷移してしまう。`S.selectMode`はビューを跨いだグローバル状態
なので、気づかずに他のビュー（Todayなど）へ移動すると、そこでも選択モードのUI
（ドラッグハンドル非表示・チェックだけの行など）になってしまい操作しづらい。

### 原因

`handleBulkEdit()`内の各フィールド処理で、選択モード解除(`S.selectMode=false;
S.selectedIds=[];`)の有無が**フィールドごとにバラバラ**だった：
- ✅ 解除していた：`complete`（完了）・`parent`（親設定）・`detach`（独立化）・`delete`（削除）
- ❌ 解除していなかった：`dates`（日付）・`tags`（タグ）・`project`（プロジェクト）・
  `repeat`（繰り返し）・`flag`（フラグ）

### 修正内容

`dates`/`tags`/`project`/`repeat`/`flag`の完了ハンドラにも`S.selectMode=false;
S.selectedIds=[];`を追加し、全フィールドで一括処理完了時に選択モードを自動終了する
よう統一。モーダルの「キャンセル」ボタンは従来通り選択状態を維持（誤ってキャンセルしても
選び直せるように）。

Node.js構文チェック済みでエラーなし。

---

## 🆕 Dashboard「期限切れ」もっと見るが専用ビューに繋がっていない問題・修正（2026-07-05）

### 症状

Dashboardの「期限切れ」セクションの「もっと見る →」をタップしても、期限切れタスクだけの
一覧は表示されず、実質的に「今日」ビュー（`S.view='today'`）に遷移していた。
`today`ビューは「期限が今日」または「フラグ付き」のタスクしか拾わないため、
期限切れタスクの一部（フラグなし・今日より前が期限）が表示されない不整合があった。

### 原因

`renderDashboard()`内の`section()`呼び出しで、「期限切れ」セクションの`viewName`引数が
誤って`'today'`になっていた（コピペ起因と推測）。専用の`overdue`ビュー自体が存在しなかった。

### 修正内容

新規`overdue`ビューを追加し、新規ビュー追加チェックリスト（本ファイル内、旧セッション記載）
に沿って全箇所を登録：
- `getTasks()`：`dueAt<today`かつ未完了のタスクを抽出するフィルタ条件を追加
- `counts()`：`overdue`件数を追加
- `renderSidebar()`の`ALL_SYS`：サイドバーに「Overdue」項目を追加（Todayの直下）
- `ALL_NAV_ITEMS`：ボトムナビカスタマイズ候補に追加
- `getNavSequence()`の`SYS_VIEWS`：前後ナビゲーション対応
- `renderContent()`の`titles`：タイトルバー文字列
- `VIEW_HELP`：？ツールチップの説明文
- `openViewHelp()`のアイコンmap
- `renderEmpty()`：空状態メッセージ
- `ICONS.overdue`：専用アイコン（アラームクロック風）を追加
- `renderList()`の`showSubsInView`・`renderRow()`の親タスク名表示：`today`/`flagged`と同様に`overdue`でもサブタスクの親タイトルを表示するよう対象に追加
- `renderDashboard()`：「期限切れ」セクションの`viewName`を`'today'`→`'overdue'`に修正

修正後、Node.js構文チェック（本ファイル冒頭のルール①）で全JS文字列の構文エラーがないことを確認済み。



---

## 🚨 Claude作業ルール（再発防止・必読）

### ① index.html のJS文字列を直接編集するときは必ずNode.js構文チェックを通してからpushする

index.htmlの描画関数（`renderDrawer()`など）はJSのテンプレートリテラルではなく**1行の巨大な文字列連結**（`+'<div...>'`形式）になっている。
Pythonでこの文字列を置換するとクォート・バックスラッシュのエスケープが非常に壊れやすく、**過去2回同じ事故が発生した**（左メニュー・下部ナビが消える全壊）。

**必須手順：**
```
1. Python/sedで置換
2. 置換できたか count() で確認（0件ならミス）
3. Node.js で構文チェック ← これを省くと事故になる
4. OK が出たらファイル書き込み・commit・push
```

Node.js構文チェックのコマンド（テンプレ）:
```python
import subprocess, tempfile, os
tmpf = tempfile.mktemp(suffix='.html')
open(tmpf, 'w').write(c)  # c = 修正後のHTML文字列
r = subprocess.run(
    ['node', '-e',
     "const h=require('fs').readFileSync('" + tmpf + "','utf8');"
     "const m=h.match(/<script>([\\s\\S]*?)<\\/script>/g)||[];"
     "const j=m.map(s=>s.replace(/<\\/?script>/g,'')).join('\\n');"
     "try{new Function(j);process.stdout.write('JS_OK\\n');}catch(e){process.stderr.write('JS_ERR:'+e.message+'\\n');}"],
    capture_output=True, text=True
)
os.unlink(tmpf)
# JS_OK が出たらファイル書き込みへ。JS_ERR が出たら書き込み禁止。
```

### ② index.html のJS文字列内に含まれる文字列の実際のバイト列を必ず確認してから置換する

`repr()` でPythonが表示する `\\'` は **ファイル上の1文字の `'`** であり、バックスラッシュではない。
置換対象を構築する前に必ず以下を実行してバイト列を確認すること：
```python
c = open('index.html').read()
idx = c.find('目印となる文字列')
print(repr(c[idx:idx+200]))  # 実際のバイト列を確認
```

### ③ Pythonスクリプトはファイルに書き出してから実行する（heredoc禁止）

`bash_tool` に `<< 'ENDSCRIPT'` で渡すheredoc内にPython文字列リテラルのエスケープシーケンスを混在させると、bashとPython双方のエスケープが干渉して `SyntaxError` になる。
**Pythonスクリプトは必ず `cat > /tmp/fix.py` 等でファイルに書き出し、`python3 /tmp/fix.py` で実行すること。**

---

## 🐛 LogbookがiPadサイドバーに表示されない問題・修正（2026-06-26）

### 症状

iPadの左サイドバーの「ビュー」セクションにLogbookが表示されず、誤完了したタスクを
復元するためのLogbookに辿り着けない。

### 原因

`renderSidebar()`のサイドバー項目構築ロジックが、ボトムナビの保存順（`bnavOrder` =
`localStorage`の`bnav_order`）を基準に並び替えていた。`ALL_SYS`にLogbookが追加
されていても、`bnavOrder`（ユーザーのボトムナビカスタマイズ保存値）にない項目は末尾に
フォールバックするため、スクロールしないと見えない位置に押し込まれていた。

また`ALL_NAV_ITEMS`（ボトムナビカスタマイズ候補リスト）にもLogbookが未登録で、
ボトムナビへの追加もできない状態だった。

### 修正内容

1. `ALL_NAV_ITEMS`に`{v:'completed', label:'Logbook', icon:()=>ICONS.check}`を追加
   → ボトムナビカスタマイズ画面から追加できるようになった
2. `renderSidebar()`のnavItems構築を`ALL_SYS`固定順に変更
   → `bnavOrder`に関係なく、常に設計通りの順序でサイドバーに表示される
3. `getNavSequence()`のハードコード`SYS_VIEWS`に`assigned`/`completed`/`gantt`を追加
   → 前後ナビゲーション（◀▶）でもこれらのビューを拾えるようになった

### 教訓

サイドバー表示のために必要な登録箇所（HANDOVER.mdの「新規ビュー追加時の注意」参照）に
加え、**`ALL_NAV_ITEMS`**も忘れずに追加すること。`ALL_SYS`に入れただけでは、
既存ユーザーの`bnav_order`保存値によっては末尾に押し込まれ、事実上見えない状態になる。
**サイドバーはnow`ALL_SYS`固定順で表示されるため、以後は`ALL_SYS`の項目順が
サイドバーの表示順そのものになる。**

---

## 📝 2026-06-26 セッション④ 作業まとめ

### 実施した修正・改善（全て動作確認済み）

1. **Taskraにタスク追加**（Supabase直接INSERT）
   - 「川島さんからの予約GO改修相談2026/06/26」、予約GOプロジェクト、期限6/29、優先度中

2. **Logbookアイコン復元**（切り戻しで消えていたICONS.archiveを再追加）
   - ICONS定義にarchive（アーカイブ箱SVG）を追加、LogbookがICONS.checkになっていたのを修正

3. **サイドバーのビュー順をALL_SYS固定順に変更**（`148ebf3`）
   - bnav_order（ユーザーのボトムナビ保存順）に引きずられてサイドバー順がバラバラになっていた
   - `navItems=[...ALL_SYS]`（スプレッドコピー）で固定順に。以後改修で順序が変わらない
   - 確定順：Dashboard→Inbox→Next→Today→Forecast→Flagged→Assigned→Review→Logbook→Search→Note→Gantt

4. **フィルタバー刷新完了**（3ステップに分割して安定適用）
   - ステップ1（`cc461e5`）：完了ボタン削除のみ
   - ステップ2（`8f7177b`）：CSS刷新（枠線なし・フラットpill・横スクロール対応）
   - ステップ3（`a9eb2f2`）：セパレーター追加（ツール系｜フィルター群｜ソート）

### ⚠️ フィルタバー壊れた件の教訓

以前フィルタバーを一括変更したら壊れた原因の推測：
- `let html = ...` という変数名がグローバルの`html`と干渉した可能性（今回は`_tfh`に変更）
- `@media(pointer:fine)`の追加がCSSの`{}`バランスに影響した可能性（今回は見送り）
- 今回は3ステップに分けて1つずつ確認しながら適用→問題なく完了

### ⚠️ PWAキャッシュについて（再掲）

SW戦略をnetwork-firstに変えたら悪化した。v50（stale-while-revalidate）のまま維持。
PWA側のSW変更は慎重に。

---

## 📝 2026-06-26 セッション③ 作業まとめ

### 実施した修正（全てコミット済み・動作確認済み）

1. **parseQA: 全角括弧内の曜日が欠落するバグ修正**（`3476008`相当）
   - 例：「7/8（火）9（水）のロードマップ」→「7/8（）9（水）」になっていた
   - `[（(]曜字[）)]`パターンを検出し、括弧内は日付解釈せずタイトルとして保持

2. **goto-proj: スマホでdrawerを閉じてからプロジェクト遷移**
   - タスク詳細のプロジェクト移動ボタンを押しても画面が変わらなかった問題
   - `S.drawerOpen=false`を追加

3. **AI: サブタスクの開始日等を変更できない問題修正**
   - `context.tasks`に`parentTaskId`を追加（AIがサブタスクを識別できなかった）
   - systemPromptに「サブタスクもupdate_taskで更新可能」を明記
   - update_taskのdescriptionにサブタスク対応を追記

4. **プロジェクトチップ（go-proj）のスワイプ誤タップ防止**
   - FAST TAPに`_touchMoved && el.dataset.a==='go-proj'`ガードを追加

5. **タスク追加時にプロジェクト最上部に配置**
   - `topOrderInProject()`ヘルパー追加
   - クイック追加・＋ボタン・Inbox→PJ割り当て時、全て最上部orderをセット

### 未完了：フィルタバーデザイン刷新

フィルタバーの刷新（完了ボタン削除・フラットpill・セパレーター）を試みたが、
適用後にボトムナビ・サイドバーが消える重大バグが再現。2回試みて2回失敗。

**判明していること：**
- フィルタバー単体では過去に動作していた（数時間正常稼働）
- ①〜⑤の修正と組み合わせると壊れる
- シークレットモードでも再現→SW/キャッシュは無関係
- コードのJS/CSSの文法チェックは通っている
- 変数名衝突の可能性：`_tfh`、`_hasQF`、`SEP`等と既存コードの何かが干渉か

**次回やること：**
- `@media(pointer:fine)`の追加がCSSの`}`バランスを崩す可能性を確認
- フィルタバーJS変更を最小限（完了ボタン削除のみ）から段階的に適用
- ブラウザのコンソールエラーを確認できる環境で作業する

### ⚠️ PWAキャッシュについて

PWAのSW戦略を`stale-while-revalidate`→`network-first`に変えたら悪化した（v51）。
v50（stale-while-revalidate）に戻してある。PWA側はSW変更せずに対処すること。

---

## 📝 2026-06-26 セッション② 作業まとめ

このセッションで実施した内容。

1. **LogbookがiPadサイドバーに表示されない問題を修正**（コミット `a6d76ca`）
   - 前セッションでLogbook（completedビュー）は実装済みだったが、サイドバーの並び順が
     ボトムナビ保存順（`bnav_order`）依存だったため、未登録のLogbookが末尾に押し込まれ
     事実上見えない状態になっていた。
   - `renderSidebar()`のnavItems構築を`ALL_SYS`固定順に変更し、常にReviewの直下に表示されるよう修正。
   - `ALL_NAV_ITEMS`にLogbookを追加（ボトムナビカスタマイズ候補に出るように）。
   - `getNavSequence()`のハードコード`SYS_VIEWS`にassigned/completed/ganttを追加。

2. **HANDOVER.md更新**（コミット `a28f3bc`）
   - 上記バグの原因・修正・教訓を記録。

### ⚠️ 今後の注意（今回判明した教訓の補足）

新規ビューを`ALL_SYS`に追加しても、**`ALL_NAV_ITEMS`に入れないとボトムナビカスタマイズ
候補に出ない**。さらに既存ユーザーの`bnav_order`保存値にない項目はサイドバー末尾に
流れていた（今回の修正で`ALL_SYS`固定順になったため以後は問題なし）。

「新規ビュー追加時のチェックリスト」（下記セクション参照）に **`ALL_NAV_ITEMS`への追加**
を必ず含めること。

---

## 📝 2026-06-26 作業まとめ（セッション引き継ぎ）

このセッションで実施した内容。コミット順（古い→新しい）に記載。詳細は各コミットメッセージとこのファイルの各セクション参照。

1. **ボトムナビのSidebar/AIボタン幅バグ修正**：固定フランクのつもりが`flex-shrink:0`のみでflex-growが残り、中央領域と同じ1/3幅になっていた。`flex:0 0 58px`に修正。
2. **AIボタン/パネルのUX改善**：上部AIボタン（✦）はスマホでは下部ナビと重複するため非表示化（PCのみ表示）。AIパネルに背景オーバーレイ＋ドラッグハンドルを追加し、外タップ・下スワイプで閉じられるように。
3. **AIアシスタント（アプリ内チャット）の機能拡張・整理**：
   - `completedTasks`（直近14日の完了タスク）をAIのcontextに追加 → 「今日完了にしたタスク一覧出して」等に対応
   - `complete_task`/`reactivate_task`の2ツールを廃止し`update_task`の`status`フィールド（active/inbox/completed/archived）に統合。コード量削減・保守性向上が目的
4. **Taskra MCPサーバーを新規実装**（`supabase/functions/mcp-server/index.ts`）：Claude.aiのカスタムコネクタからTaskraを直接操作できるように。**手順・トラブルシュートは下の「## MCP連携」セクション参照。動作確認済み**（list_tasks/update_task等で実際にタスク操作・一括期限変更を実施し正常動作を確認）
5. **メモ欄クリアボタンの位置変更**：Note詳細・タスク詳細どちらも、🗑クリアボタンが他ボタンと近すぎて誤タップしやすかったため、ツールバーから削除し下部「•••」メニューに移動
6. **Logbook（完了済み一覧）をサイドバーに追加**：「誤って完了にしたタスクを探して戻したい」という要望に対応。実は`getTasks()`のcompletedフィルタ・`VIEW_HELP`・`titles`・`renderEmpty`まで**以前のセッションで実装済みだったが、サイドバーへの導線だけが欠落**していて誰も到達できない状態だった（後述「新規ビュー追加時の注意」参照）。

### ⚠️ 新規ビュー追加時の注意（今回判明した教訓）

`S.view`に新しい値を追加する際、関連箇所が散らばっているため**1か所だけ実装して終わったつもりになる事故が起きやすい**。チェックリスト：

- [ ] `renderSidebar()`内`ALL_SYS`配列（サイドバー項目）
- [ ] `renderContent()`内`titles`オブジェクト（タイトルバー文字列。**抜けると無言で空白になる**）
- [ ] `VIEW_HELP`オブジェクト（？ツールチップの内容。**抜けると？タップで無反応**）
- [ ] `openViewHelp()`内のアイコンmap（？ツールチップのアイコン）
- [ ] `renderEmpty()`内の空状態メッセージ
- [ ] `getTasks()`内のフィルタ・ソート条件
- [ ] `renderContent()`の`qaHidden`配列・`renderTaskFilters()`の`showToggle`（クイック追加バー・フィルタツールバーを出すか）
- [ ] **`ALL_NAV_ITEMS`への追加**（ボトムナビカスタマイズ候補に出るため。**省くとサイドバー表示順も狂う**ことがあった。基本的に全ビュー追加推奨）

今回の`completed`ビューは上記のほぼ全部が**過去のセッションで実装済み**だったにもかかわらずサイドバー項目だけが無かったため誰にも見えなかった。新規ビュー追加を依頼されたら、まずこのチェックリストで既存実装の有無を確認すると手戻りが減る。

---

## 🚨 タスクが1000件超で読み込まれず消える問題・根本修正（2026-06-23）

### 症状

特定のタスク（例:「発表会」を含むタスク）が一覧にもInboxにも**検索結果にも出ない**。
完全に消えたように見えるが、Supabase上にはデータが存在する（service roleで確認可）。

### 原因

PostgREST（Supabase REST API）は1リクエストあたり**最大1000行**で打ち切る。
`dbAll`/`dbAllNoFilter` は `SB.from('tasks').select('*')` を件数指定なしで投げており、
タスク総数が1000件を超えると**超過分が一切読み込まれない**。読み込まれない＝
`S.tasks`に存在しない＝一覧・Inbox・検索すべてに出ない（検索もS.tasks上での
フィルタなので当然ヒットしない）。

当該ユーザー（mstd0520@gmail.com / 448933d7-...）はタスク1321件（active 331・
inbox 33・completed 957、archive 0）で、上限を321件超過していた。どの行が落ちるかは
PostgRESTの返却順（≒物理順）依存で不定のため、消えるタスクは一見ランダムに見える。

notes(109)/projects(26)/tags(3)/sections(12)は1000未満のため影響なし。tasksのみ。

### 修正内容

`dbAll`/`dbAllNoFilter` を `.range(from,from+999)` で全行をページ取得するよう変更
（`_pageAll`ヘルパーを追加。1ページ1000行、返却が1000未満になるまでループ）。
順序を安定させるため `.order('id',{ascending:true})` を付与。RLSはそのまま効くので
共有プロジェクトのタスクも従来通り取得される。

→ デプロイ後にアプリを再読み込み（PWAは更新反映）すれば、超過分のタスクが全て
復活して見えるようになる。DBの書き換えは一切不要（データは無傷だった）。

### 今後の改善余地（任意）

completed が957件と肥大化しており、今後さらに増えると毎回全件ロードが重くなる。
- 完了タスクは「直近N日 or 直近N件」だけ初期ロードし、Completedビューを開いた時に
  追加取得する遅延ロード化
- もしくは古い完了タスクの定期アーカイブ
を検討するとロード時間・通信量を抑えられる。

---

## 🐛 Inboxのタスクが消える問題・修正（2026-06-23）

### 症状

Inboxに入れたはずのタスクの一部が一覧から消える。サイドバーのInboxバッジ件数は
そのまま（例: バッジ「4」なのに一覧は2件しか出ない）。

### 原因

「現在」フィルタ（`S.hideNotStarted`／開始日が未来＝未着手のタスクを除外）が、
`getTasks()` 内でビューを問わず全ビューに適用されていた（Inboxにも効いていた）。
このため開始日が未来のInboxタスクが一覧から除外されていた。一方、Inboxバッジ件数
（`counts().inbox`）は `hideNotStarted` を考慮しないため、件数と一覧が食い違っていた。

「現在」フィルタはボトムナビのアイコン長押し（500ms）でもトグルされ（通知は上部に
2.2秒のみ）、誤操作で気づかずONになりやすい。`hideNotStarted` はセッション限りの
状態（localStorage非永続）なので、リロードすると消えたタスクは元に戻る。

### 修正内容

`getTasks()` の該当行を `S.view!=='inbox'` でガードし、Inboxビューでは「現在」
フィルタを適用しないよう変更：

```js
// 修正前
if(S.hideNotStarted){tasks=tasks.filter(x=>!isNotStartedTask(x))}
// 修正後
if(S.hideNotStarted&&S.view!=='inbox'){tasks=tasks.filter(x=>!isNotStartedTask(x))}
```

Inboxは「未分類・未整理のタスクを集めて整理する受信箱」であり、開始日が未来でも
必ず表示する必要がある（見えないと整理対象から漏れる）。これによりInbox一覧＝
バッジ件数で一致するようになる。Today／プロジェクト等の他ビューでは従来通り
「現在」フィルタが機能する。

### 補足（未対応・任意）

Inboxビューでもツールバーの「現在」トグルボタンは表示・押下可能なまま（押しても
Inboxでは何も起きないのが正しい動作）。混乱を避けたい場合はInboxビューで同ボタンを
非表示にする選択肢もあるが、今回は最小修正に留めた。

---

## 🚨 Stripe webhook 障害・修正（2026-06-23）

**事象**: Stripeから「taskra-paymentエンドポイントへ9日間連続でエラー」のメールが届き、
Stripeがエンドポイントを自動無効化した（2026-06-14頃〜）。
14リクエストが "other errors" で失敗。この間の課金イベントは全て取りこぼされていた。

**根本原因**: `stripe-webhook` Edge Functionが `verify_jwt: true` で設定されていた。
StripeはSupabase JWTを送れないため、Supabaseミドルウェアが関数本体に到達する前に
401を返していた（stripe-signature検証すら実行されていなかった）。

**修正内容**（Supabase Edge Function v22→v23）:
1. `verify_jwt: false` に変更（セキュリティはstripe-signature検証で維持）
2. `invoice.payment_succeeded` ハンドラを追加
   → これがないと月次自動更新のたびにプランが維持されない恐れがあった

**対応手順（再発時）**:
1. Supabase MCPで stripe-webhook を `verify_jwt: false` で再デプロイ
2. Stripe ダッシュボード → Developers → Webhooks → taskra-payment → 「有効にする」
3. 「イベントの配信」タブでテストイベントを送って確認

**登録済みイベント**（2026-06-23時点）:
- `checkout.session.completed`（初回購入）
- `customer.subscription.created`（サブスク作成）
- `customer.subscription.updated`（プラン変更）
- `customer.subscription.deleted`（解約・ダウングレード）
- `invoice.payment_succeeded`（月次自動更新 ← 今回追加）

**注意**: `verify_jwt` は絶対に `true` に戻さないこと。
Stripe webhookは公開エンドポイントである必要があり、
セキュリティはstripe-signatureヘッダーで担保する。

---

## ⚠️ iPadでタスクの並び替え（ドラッグ）が機能しなくなった（2026-06-20 修正・直前のhover修正の副作用）

### 症状

直前の「2タップ問題」修正（`.nav-item:hover`/`.trow:hover`を`@media(pointer:fine)`で
ガード）の直後、iPadでタスクのドラッグ並び替えが機能しなくなった。iPhoneは問題なし。

### 原因（直前修正の副作用）

タスクのドラッグ&ドロップは画面幅で完全に実装が分岐していた：
- `!isMobile`（幅>768px、iPadはここに該当）→ PC用: ネイティブHTML5 Drag&Drop
  （`.task-drag-handle`への`mousedown`→`draggable=true`→`dragstart`という、
  マウス操作前提の実装）
- `isMobile`（幅<=768px、iPhoneはここに該当）→ 長押しタッチドラッグ
  （`touchstart`/`touchmove`/`touchend`を直接使う、タッチ専用の実装）

iPadは直接指でタッチしていても画面幅だけで「PC」判定されマウス用実装が使われていたが、
これが動いていたのは、WebKitが「`:hover`で見た目が変わる要素はタッチでも合成mousedown
イベントを発火する」という挙動に偶然乗っかっていたため。直前の修正で`.trow:hover`を
`@media(pointer:fine)`配下に移したことで、直接タッチ時にこの合成mousedownが発火しなくなり、
`mousedown`起点の`draggable=true`設定が行われずドラッグが始まらなくなった
（2タップ問題とドラッグ問題は同じWebKitの挙動の表裏だった）。

### 修正内容

画面幅ベースの`if(!isMobile){PC実装}else{タッチ実装}`という排他分岐をやめ、
タッチ対応端末かどうか（`'ontouchstart' in window || navigator.maxTouchPoints>0`）で
タッチドラッグ実装も独立して有効化するよう変更。iPad（幅>768pxかつタッチ対応）では
PC用実装とタッチ用実装の両方が有効になり、指で直接ドラッグした場合は長押しタッチドラッグが、
トラックパッド/マウスでドラッグした場合はネイティブDrag&Dropが、それぞれ適切に動作する。
タッチ開始時に`touchstart`で`preventDefault()`しているため合成mousedownは発生せず、
両実装が同時に有効でも競合しない。

### 教訓

- iPadのようなタッチ＋トラックパッド両対応端末を画面幅だけで「PC」「モバイル」に
  分類するのは危険。入力方式の判定にはタッチ対応の有無（`maxTouchPoints`等）を見るべき。
- WebKitの「hover CSSがあるとタッチでも合成mousedownを発火する」という挙動は、
  一見無関係な機能（hoverの見た目）が別の機能（ネイティブdrag&drop）の動作条件に
  なってしまう典型例。CSSの`:hover`を変更する際は、その要素にmousedown/dragstart等の
  マウスイベント前提のロジックが乗っていないか必ず確認すること。

---

## ⚠️ iPadでプロジェクト/タスクが2タップしないと切り替わらない（2026-06-20 修正）

### 症状

iPadで、サイドバーのプロジェクトをタップしてもタスク一覧がそのプロジェクトの
タスクに切り替わらず、もう一度タップするとようやく切り替わる。タスク一覧から
タスクをタップした時も同様に2タップ必要。iPhoneでは発生しない。

### 原因

`.nav-item:hover`（プロジェクト/ビュー一覧の行）と`.trow:hover`（タスク一覧の行）に
`:hover`のCSSルールが`@media(pointer:fine)`等でガードされず素のまま定義されていた。

iPadOSはMagic Keyboardなどトラックパッド付きアクセサリが使える関係で、画面を直接
指でタップしても「1回目のタップ＝:hover状態の発火」「2回目のタップ＝実際のclickの発火」
という2段階扱いになるWebKit特有の挙動がある（iPhoneにはこの機構がないため発生しない）。
同ファイル内の`.dt-section-head`では既に`@media(pointer:fine)`で正しくガードされており
（5月以前の対応と思われる）、`.nav-item`と`.trow`だけ対応が漏れていた。

### 修正内容

以下のhoverルールを`@media(pointer:fine)`でガードし、ファインポインタ（マウス/
トラックパッド）使用時のみ適用されるよう変更：
- `.nav-item:hover`（プロジェクト・ビュー・タグ一覧の行）
- `.trow:hover`（タスク・ノート一覧の行）
- `.chk:hover`（タスク完了チェックボックス・同種の2タップ症状が起きうるため予防的に修正）
- `.fc-task:hover`（カレンダービューのタスクチップ・同様の理由で予防的に修正）

### 既知の積み残し

`.proj-item:hover .proj-actions{display:flex}` / `.tag-item:hover .tag-actions{display:flex}`
（プロジェクト/タグの編集・削除アイコンをhoverで表示する処理）も同様に素の`:hover`で
未ガードのまま残っている。今回は意図的に触れていない。理由は、`@media(max-width:768px)`で
狭い画面では常時表示されるフォールバックが既にあるが、iPad幅でトラックパッドを
使っていない場合に同様にガードすると、編集・削除アイコンに到達する手段がなくなって
しまう（タップで表示する代替UIが現状ない）ため。プロジェクト行のタップでまだ
2タップが必要な場合はこのルールが原因の可能性があり、その際は「タップで開く
ケバブメニュー」等、別の表示方式の追加が必要になる。

### 教訓

- WebKitのこの挙動は、クリックされる要素自身だけでなく、その要素やhover時に
  見た目が変わる範囲全体に`:hover`ルールがあると発生しうる。1箇所直して終わりにせず、
  同じ要素・同じクラスに複数の`:hover`ルールが重なっていないか確認すること。
- 同じ修正パターン（`@media(pointer:fine)`でガード）が既にコード内の別箇所
  （`.dt-section-head`）に存在していたので、今後新しい`:hover`ルールを追加する際は
  最初からこのパターンに倣うとよい。

---

## ⚠️ iPadでサイドバー左下のユーザーメニューがホームインジケーターに隠れてタップできない（2026-06-20 修正）

### 症状

iPadのサイドバー左下にあるユーザーメニュー（アバター＋名前＋プラン＋▲シェブロン）が
画面の下端にほとんど隠れてしまい、タップできない。

### 原因

`.sidebar-foot`（サイドバー最下部のフッター、ユーザーメニューのトリガーを内包）に
`padding-bottom:env(safe-area-inset-bottom)`が設定されていなかった。モバイル時の
下部ナビ`.bot-nav`には同様の処理が既に入っているが、iPad幅レイアウトで使われる
`.sidebar-foot`側だけ抜けていた。`viewport-fit=cover`を使っている都合上、
ホームインジケーターのジェスチャー領域と要素が重なり、タップ判定もOSのジェスチャーに
奪われてしまっていた。

### 修正内容

`.sidebar-foot`に`padding-bottom:env(safe-area-inset-bottom)`を追加。
ポップアップメニュー自体の位置は`sidebar-foot`の`getBoundingClientRect()`を基準に
JS側で動的計算されているため、追加修正不要で自動的に正しい位置に追従する。

### 検討した代替案（不採用）

UIパターン自体（アバター＋シェブロンを左下に置き、タップで展開）の再検討も検討したが、
Notion/Slack/Linear等の主要プロダクトでも同じ配置・構成が広く使われている定番パターンであり、
今回の問題はパターンの問題ではなく純粋にセーフエリア対応漏れの実装バグと判断し、
UI自体の作り直しは行わなかった。

---

## ⚠️ iPad外部キーボード使用時、コメント入力フォーカスで画面が最上部へ飛ぶ（2026-06-20 修正）

### 症状

タスク詳細のコメント欄をタップ（フォーカス）すると、画面全体が最上部へジャンプする。
iPadに外部キーボードを接続している時に発生・視認されやすい。

### 原因

2026-05-17に一度修正済み（コミット`d15d324`）だったが、対策が`.drawer-body`内の
スクロール補正のみで、`window`/`document.body`レベルの誤スクロールには対応していなかった。
WebKitは、入れ子の`overflow:auto`コンテナ内のinput/textareaへフォーカスした際、
ネイティブの「フォーカス要素を可視領域に入れる」処理で誤って`window`/`body`側を
スクロールしてしまうことがある。オンスクリーンキーボード使用時はキーボード出現に伴う
レイアウト変化とタイミングが重なって目立たないことがあるが、外部キーボード接続時は
オンスクリーンキーボードが出ないためこの誤スクロールがそのまま視認される。

### 修正内容

`document`に`focusin`のグローバルリスナーを追加し、input/textarea/contenteditableへの
フォーカスのたびに`window.scrollTo(0,0)`・`document.documentElement.scrollTop`・
`document.body.scrollTop`を強制的に0へリセット（フォーカス直後＋次フレーム＋350ms後の
3段階）。本アプリは`.layout{height:100vh;overflow:hidden}`設計であり、window/bodyレベルの
スクロールはモバイル・デスクトップ両レイアウトとも常に0であるべきため、全画面・全入力欄に
対して安全に適用できる。

既存の`.drawer-body`内スクロール補正（`_cmSetupInput`内の`inp.onfocus`）は、コメント欄を
drawer-body内で見える位置に保つための別目的の処理として維持。

### 教訓

- 同じ症状の不具合を再度報告された場合、過去の修正が「症状の一部だけ」を対象にしていて
  別の発生経路（このケースでは外部キーボードの有無）でカバーできていなかった可能性を疑う。
- iOS Safariのフォーカス時自動スクロールはCSSや`preventScroll`では完全に制御できないため、
  「発生を防ぐ」のではなく「発生した後に正しい位置へ戻す」リアクティブな補正が現実的。

---

## ⚠️ Supabase接続待ちタイムアウトによるデータ消失バグ（2026-06-20 修正）

### 症状

iPadで登録したタスクがiPhoneに反映されない、または最終的に画面から消える。

### 原因

`init()`はSupabase接続（Supabase-js CDN読み込み＋`auth.getSession()`）が完了するまで
最大5秒待ってからデータをロードしていたが、5秒を超えてタイムアウトすると、未接続のまま
処理を続行していた。その状態だと`dbAll/dbPut/dbDel`がローカル限定の`IndexedDB`版
（Supabaseに一切送信されないバージョン）のままになっており、その間に保存したタスクは
端末のIndexedDBにしか残らない。その後、定期同期（120秒ポーリング・visibilitychange）で
`loadAll()`がSupabase側データで`S.tasks`等を丸ごと上書きするため、ローカル限定で
保存されたデータは画面から消える（＝他端末にも当然反映されない）。

電波の弱い場所・低速回線でCDN読み込みや認証確認が5秒を超えると発生しうる。

### 修正内容

- `init()`: Supabase接続待ちを5秒から20秒に延長。さらにタイムアウトしても未接続のまま
  ローカル限定モードにはフォールバックしないよう変更。`window._sbReady && window._SB`が
  揃わない限り`loadAll`/`seed`/孤立タスク修復などのデータ読み書きを一切行わず、
  赤いエラーバナー（`showConnError()`）を表示し、`waitForSBAndRecover()`が2秒おきに
  接続を確認、接続でき次第自動でデータを再取得して復旧する。
- `setupSB()`: 初期化失敗時に`window._sbReady=true`を立てて「準備完了」と偽装していた
  バグを修正。失敗時は4秒後に自動で`setupSB()`を再試行する（`window._sbSetupDone`フラグで
  二重初期化・認証リスナーの二重登録を防止）。

### 教訓

- オンライン専用（Supabaseが正）のアプリで、接続未確認のままデータ操作系の関数を
  「とりあえず動くローカル代替」にフォールバックさせると、エラーも出ないまま
  サイレントにデータが失われる。未接続時は機能を止めて再試行する方が安全。
- `_sbReady`のようなグローバルフラグを「失敗時にもtrueにする」実装は、呼び出し側が
  フラグだけを見て安全だと誤判断する典型的な事故パターン。失敗時はfalseのまま
  保つか専用のエラーフラグを使うこと。

---

## ⚠️ 作業開始前に必ず読むこと（事故防止）

### git push前の必須チェック

```bash
# 必ずpull --rebaseしてからpush
git pull --rebase
git push
```

**やってはいけないこと:**
- `git pull`なしでいきなり`git push` → リモートの最新コミットを上書き事故が発生する
- Claudeが別セッションで作業した変更がリモートにある場合、pushが競合で失敗 → `--force`で解決しようとすると最新データが消える

**push失敗時の対応:**
```bash
git pull --rebase
git push
# コンフリクトが出た場合
git checkout --theirs index.html   # リモート優先で解決（慎重に）
git add index.html
git rebase --continue --no-edit
git push
```

**再発防止のルール:**
1. 毎セッション開始時は必ず`git clone`からやり直す（古いローカルを使い回さない）
2. push直前に`git status` / `git log --oneline -3`で確認する
3. コンフリクト解決は`--theirs`（リモート優先）を基本とする

---

## ⚠️ FAST TAPとdrawerの相互作用（重要）

### 概要

`index.html`末尾付近に **FAST TAP** というグローバルリスナーがある：

```js
document.addEventListener('touchend', function(e) {
  const el = e.target.closest('[data-a],[data-k],button');
  e.preventDefault();
  el.click(); // touchendで強制click発火
}, {passive: false});
```

### 危険なケース

drawerが開いている状態で、drawerの背後にある要素（リスト行など）の上に
drawerの✕ボタンが重なっている場合：

1. `touchend` → FAST TAPが`e.target`（実際に触れた要素）を取得
2. drawerの背後の`[data-a]`要素をclick() → 意図しない処理が実行される
3. その後ブラウザのネイティブclickが来て正しい処理が走るが、順番が逆になる

### 対処済みの修正

```js
// drawer open時はdrawer外の要素へのFAST TAPを無効化
const dr = document.getElementById('drawer');
if (dr && dr.classList.contains('open') && !el.closest('#drawer')) return;
```

### 教訓

- drawerを新しいビューから開く実装をする時は必ずFAST TAPの影響を考慮する
- `close-note` / `close-drawer` などの閉じる操作は必ず `renderNoteDrawer()` + `renderContent()` の両方を呼ぶ
- searchビューでnoteを開いた際に✕が効かない症状が出たらFAST TAPを疑う

---

## 概要

| 項目 | 内容 |
|---|---|
| アプリ名 | Taskra（タスクラ） |
| リポジトリ | https://github.com/dat0925/task-app |
| 公開URL | https://app.taskra.jp |
| 種別 | PWA（Progressive Web App）/ シングルファイル構成 |
| フロントエンド | Vanilla JS + HTML（index.html 単一ファイル） |
| バックエンド | Supabase（プロジェクトref: `sfhtvtcmgueystyuhzvd`） |
| ホスティング | GitHub Pages（CNAME: app.taskra.jp） |
| デプロイ方法 | GitHub mainブランチへのpushで自動反映 |

---

## Supabase 構成

### 接続情報

| 項目 | 値 |
|---|---|
| Project URL | `https://sfhtvtcmgueystyuhzvd.supabase.co` |
| Anon Key | index.html内に直書き（anonキーはRLSで保護されているため公開可） |
| 注意 | `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` は予約語。Edge Functionsでは `SB_ANON_KEY` / `SB_SERVICE_ROLE_KEY` を使うこと |

### テーブル一覧・RLS状態

| テーブル | RLS | ポリシー概要 |
|---|---|---|
| `tasks` | ✅ 有効 | `user_id = auth.uid()` で自分のデータのみ |
| `projects` | ✅ 有効 | 同上 |
| `sections` | ✅ 有効 | 同上 |
| `tags` | ✅ 有効 | 同上 |
| `backups` | ✅ 有効 | 同上 |
| `app_settings` | ✅ 有効 | 同上（`user_id` + `key` で複合ユニーク） |
| `notes` | ✅ 有効 | 同上（2026-06-05 対応済み） |
| `task_comments` | ✅ 有効 | 同上 |
| `workspaces` | ✅ 有効 | メンバーのみ参照・ownerのみ編集削除 |
| `workspace_members` | ✅ 有効 | 同じワークスペースのメンバーのみ参照 |
| `user_plans` | ✅ 有効 | Stripe連携プラン管理 |
| `ai_usage` | ✅ 有効 | AIチャット使用量管理 |
| `push_notifications` | ✅ 有効 | プッシュ通知トークン管理 |

#### RLS ポリシーの型キャストについて

`notes` テーブルのみ `user_id::uuid = auth.uid()` の形式（他テーブルは `user_id = auth.uid()::text`）。
notesの `user_id` カラムは `text` 型だが、このSupabaseプロジェクトでは `auth.uid()` が `uuid` 型を返すため逆方向キャストが必要。

### Edge Functions

| 関数名 | 用途 |
|---|---|
| `ai-chat` | AIチャットプロキシ（JWT認証・プラン別使用制限） |
| `send-push` | プッシュ通知送信 |
| `cron-cleanup-notifications` | 通知クリーンアップ（定期実行） |
| `cron-line-reminder` | LINEリマインダー（定期実行） |
| `cron-repeat-start` | 繰り返しタスク開始処理（定期実行） |
| `cron-task-reminders` | タスクリマインダー（定期実行） |
| `line-webhook` | LINE Webhook受信 |
| `notify-mention` | メンション通知 |
| `stripe-portal` | Stripeカスタマーポータル |
| `stripe-webhook` | Stripe Webhook受信 |
| `mcp-server` | Claude.ai用 remote MCPサーバー（詳細は次セクション） |

---

## MCP連携（Claude.aiカスタムコネクタでTaskraを操作）

2026-06-26に追加。Claude.aiのチャットから直接Taskraのタスクを追加・更新・完了・削除できる。

### 仕組み（重要：シングルユーザー専用）

- Edge Function `mcp-server`（`supabase/functions/mcp-server/index.ts`）が remote MCP server として動作
- 認証はOAuthではなく**共有シークレットトークン方式**。Supabase Secretsの`MCP_SECRET_TOKEN`と、接続URLの`?token=`パラメータが一致すれば誰でも操作できてしまう
- どのSupabaseユーザーのデータを操作するかは`MCP_USER_EMAIL`（Secrets）で**固定**されている。マルチユーザー非対応
- **このトークンを知っている人は誰でもTaskraのデータを読み書きできる。** パスワードと同じ扱いで、チャットのスクショや公開リポジトリに値そのものを書かないこと（このファイルにも実際の値は書いていない）

### 再接続・初回設定の手順

1. Supabaseダッシュボード → Taskraプロジェクト（`sfhtvtcmgueystyuhzvd`） → Edge Functions → Secrets で以下が設定されていることを確認
   - `MCP_SECRET_TOKEN`：ランダムな長い文字列（実際の値は1Password/Notion等の非公開先を参照。このリポジトリには書かない）
   - `MCP_USER_EMAIL`：Taskraにログインしているメールアドレス
2. Claude.ai（Pro/Max）→ Customize → Connectors → 「＋」→ カスタムコネクタを追加
3. URLに以下を入力（`<TOKEN>`は上記`MCP_SECRET_TOKEN`の実際の値に置き換える）：
   ```
   https://sfhtvtcmgueystyuhzvd.supabase.co/functions/v1/mcp-server?token=<TOKEN>
   ```
4. OAuthのClient ID/Secret欄は空欄でよい
5. 「追加」→ Taskraコネクタが「未接続」から接続済みに変わればOK

### トークンを失効・再発行したい場合

1. 新しいトークンを生成（例：`python3 -c "import secrets; print(secrets.token_urlsafe(32))"`）
2. Supabase Secretsの`MCP_SECRET_TOKEN`を新しい値に更新
3. Claude.aiの既存「Taskra」コネクタを削除し、新トークン入りのURLで再追加（古いURLは無効化される）

### 提供しているツール（`mcp-server/index.ts`内`TOOLS`参照）

`list_tasks` / `add_task` / `update_task`（status指定で完了・未完了・アーカイブも可） / `delete_task` / `add_subtask` / `list_projects` / `add_project` / `list_tags` / `add_tag` / `add_note`

### トラブルシュート

- Claude.ai側で「サインインサービスへの登録ができませんでした」エラー → 大抵はSecrets未設定/値の打ち間違い（`=`や空白が混入するミスが多い）。Supabase:get_logsで`mcp-server`の401が出ていないか確認
- 動作確認はSupabase MCP（`Supabase:get_logs` service=`edge-function`）でリクエストログを見るのが早い

---

## プラン構成

| プラン | 月額 | タスク上限 | プロジェクト上限 | ノート上限 |
|---|---|---|---|---|
| Free | 無料 | 制限あり | 制限あり | 制限あり |
| Standard | ¥480 | 無制限 | 無制限 | 無制限 |
| Premium | ¥780 | 無制限 | 無制限 | 無制限 + AI機能 |

---

## フロントエンド設計

### 重要な実装ルール

- **日本語テキストを含むファイルの編集**: `str_replace` ツールはマルチバイト文字で失敗する。`python3 -c` インラインスクリプト（heredocで`/tmp/fix_xxx.py`に書いてから実行）で `str.replace()` を使うこと
- **Flex コンテナ内のテキスト**: テキストノードを直接 flex child にしない。必ず `<span>` で囲む
- **LINE内ブラウザ対応**: deep linkには `?openExternalBrowser=1` を付与してSafari/Chromeで開くようにする

### グローバル状態管理

- `S` オブジェクトに全アプリ状態を集約
- `_touchMoved` フラグでスクロールとタップを区別（touchstart でリセット）
- `_touchStartX` / `_touchStartY` で水平・垂直スワイプを両方検知
- `_touchTargetIsChev` でtouchstart時にchevron要素かどうかを判定（アコーディオン制御）
- `_lastFilterClickAt` でフィルタボタンの連打防止（400ms debounce）
- `_lastActionAt` で全ボタンの連打防止（350ms debounce）
- `_noDebounce` セット: `date-adj`系・`close-note`・`close-drawer` は連打防止対象外

### Supabase DBアクセス関数

| 関数 | 用途 |
|---|---|
| `dbAll(table)` | `user_id` フィルタ付き全件取得 |
| `dbAllNoFilter(table)` | フィルタなし全件取得（workspace_members等に使用） |
| `dbPut(table, item)` | upsert（`user_id` を自動付与） |
| `dbDel(table, id)` | id指定削除 |

### renderContentのオーバーライドに注意

searchビューの入力同期のため、`renderContent`が以下のようにラップされている：

```js
const _origRenderContent = renderContent;
renderContent = function() {
  _origRenderContent();
  if (S.view === 'search') {
    const srch = document.getElementById('srch');
    if (srch && srch.value !== S.search) srch.value = S.search;
  }
};
```

`renderContent`を参照・上書きする修正をする時は両方の参照に注意すること。

---

## UI仕様（スマホ）

### アコーディオン（サイドバー・タスク詳細）

- スマホ（≤768px）では **▶ chevron部分のタップのみ**で開閉
- バー全体タップでは開閉しない（誤操作防止）
- `touchstart`時に `_touchTargetIsChev` を判定して保持し、click時に参照
- chevronのCSSに `padding:10px` でタップ領域を拡大
- アコーディオンバーのタップ時の色変化は `pointer:coarse` で無効化済み

### mob-action-bar（タスク詳細・Note詳細）

**タスク詳細:** `削除 / 完了 / ••• / ↑ / ↓ / ✕`

`•••` メニュー内容:
- 📝 Noteに変換して削除
- 📋 複製する
- 🔗 タスクのURLをコピー

**Note詳細:** `削除 / ••• / ↑ / ↓ / ✕`

`•••` メニュー内容:
- ✅ タスクに変換して削除
- 📋 複製する
- 🔗 NoteのURLをコピー

### フィルタバー

現在・完了・共有 の固定ボタンに加え、タグクイックフィルターを追加:
- `S.tags` から「仕事」「個人」「開発」を名前で検索して動的表示
- タグが存在しない場合は非表示
- タップでON/OFF（排他選択・1タグのみ）
- ONの時はタグカラーでハイライト
- 削除済み: 優先ボタン・全開/全閉ボタン

---

## Task ↔ Note 相互変換

- **Task→Note**: `•••` メニュー「Noteに変換して削除」→ notes画面に遷移
  - `title`→`title` / `notes`→`body` / `tagIds`引き継ぎ / タスク削除
- **Note→Task**: `•••` メニュー「タスクに変換して削除」→ タスク詳細に遷移
  - `title`→`title` / `body`→`notes` / `tagIds`引き継ぎ / Note削除
- コメントは引き継がない（仕様）
- 変換前に確認モーダルあり

---

## Note検索の仕様

- 検索結果からNoteを開いても `S.view='search'` / `S.search` をリセットしない
- searchビューでも `if(S.noteOpen)renderNoteDrawer()` を呼ぶよう修正済み
- `close-note` は `renderNoteDrawer() + renderContent()` の両方を呼ぶ（片方だけでは閉じない）
- `close-note` は `_noDebounce` 対象（検索結果クリック直後でも確実に閉じられる）
- 閉じると検索結果一覧に戻る

---

## マイグレーション履歴

| ファイル | 内容 |
|---|---|
| `20250513_ai_usage.sql` | AI使用量テーブル |
| `20260513_enable_rls.sql` | 主要テーブルRLS有効化 |
| `20260513_user_plans_stripe.sql` | Stripeプラン管理テーブル |
| `20260514_grant_api_access.sql` | APIアクセス権限設定 |
| `20260515_task_comments.sql` | タスクコメントテーブル |
| `20260516_workspaces.sql` | チーム・ワークスペース機能 |
| `20260519_fix_workspace_invite_rls.sql` | ワークスペース招待RLSバグ修正 |
| `20260520_fix_workspace_rls_recursion.sql` | ワークスペースRLS再帰バグ修正 |
| `20260520_push_notifications.sql` | プッシュ通知テーブル |
| `20260605_enable_rls_notes.sql` | **notesテーブルRLS有効化（セキュリティ修正）** |

---

## 既知の注意事項・過去のバグ

- **Supabase Realtime 禁止**: WAL polling によりDisk IOが枯渇した。クライアント側Realtimeは削除済み・テーブルpublicationも無効化済み
- **プッシュ通知**: 過去にJSON stringify/parseミスマッチのバグあり（修正済み）
- **Google OAuth**: callbackページがないとリダイレクトループが起きる（修正済み）
- **`user_id=null` レコード**: `importFromIndexedDB` で古いデータを取り込む際に発生しうる。現在はRLSで保護されているが要注意
- **dt-memo-toggle重複**: 以前ハンドラが2箇所定義されていてチェックなし側が先に実行されるバグがあった（修正済み）
- **FAST TAP × drawer**: drawerが開いている時にFAST TAPがdrawer背後の要素を誤クリックする問題（修正済み・上記セクション参照）
- **Forecastグリッドの日付1日ずれ**: `renderForecast()` の日付生成が `new Date(today()+'T00:00:00').toISOString().slice(0,10)` で、UTC変換により先頭セルが「昨日」にずれていた（JST/UTC+環境で1日前になる）。ローカル日付基準の生成に修正し、先頭を確実に今日に固定（修正済み）。**同種の `toISOString().slice(0,10)` はコード内の他箇所にも残存しており、`today()`（ローカル基準）と混在させると同じズレが起きうるので注意。**
- **Forecast 期限切れバー**: 過去タスクを未来グリッドに混ぜず、グリッド上部に折りたたみバー「⚠️期限切れ N件」として集約。`getForecastOverdue()` で件数取得、`S.fcOverdueOpen` で開閉、「まとめて今日へ」（全件 dueAt を今日に）と「Overdueで整理→」を提供。設計思想＝時間軸を過去(清算)/今日(実行)/未来(計画)に分離。

---

## 関連プロダクト（raシリーズ）

| アプリ | URL | リポジトリ | 概要 |
|---|---|---|---|
| Taskra | app.taskra.jp | dat0925/task-app | タスク管理（本リポジトリ） |
| Flowra | flowra.taskra.jp | dat0925/flowra | 家計管理PWA |
| Tavera | tavera.taskra.jp | dat0925/tavera | 食事計画PWA |
| taskra-web | taskra.jp | dat0925/taskra-web | マーケティングサイト |

---

## デプロイ手順

```bash
# 1. 毎回必ずcloneからやり直す（使い回し禁止）
git clone https://github.com/dat0925/task-app.git
cd task-app

# 2. git設定（クローン直後に必須）
git config user.email "deploy@taskra.jp"
git config user.name "Taskra Deploy"

# 3. 編集後、必ずpull --rebaseしてからpush
git add index.html
git commit -m "feat: 変更内容"
git pull --rebase   # ← 必須。これを省くと上書き事故が起きる
git push https://<PAT>@github.com/dat0925/task-app.git main
```

GitHub PagesのCNAMEは `app.taskra.jp`。pushから反映まで数十秒〜1分程度。
