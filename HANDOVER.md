# Taskra（タスクラ）引き継ぎ書

最終更新: 2026-06-23

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
