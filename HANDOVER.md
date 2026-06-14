# Taskra（タスクラ）引き継ぎ書

最終更新: 2026-06-14

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
