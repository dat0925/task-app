# Taskra（タスクラ）引き継ぎ書

最終更新: 2026-06-05

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

- **日本語テキストを含むファイルの編集**: `str_replace` ツールはマルチバイト文字で失敗する。`python3 -c` インラインスクリプトで `str.replace()` を使うこと
- **Flex コンテナ内のテキスト**: テキストノードを直接 flex child にしない。必ず `<span>` で囲む
- **LINE内ブラウザ対応**: deep linkには `?openExternalBrowser=1` を付与してSafari/Chromeで開くようにする

### グローバル状態管理

- `S` オブジェクトに全アプリ状態を集約
- `_touchMoved` フラグでスクロールとタップを区別
- `_lastFilterClickAt` でフィルタボタンの連打防止（400ms debounce）

### Supabase DBアクセス関数

| 関数 | 用途 |
|---|---|
| `dbAll(table)` | `user_id` フィルタ付き全件取得 |
| `dbAllNoFilter(table)` | フィルタなし全件取得（workspace_members等に使用） |
| `dbPut(table, item)` | upsert（`user_id` を自動付与） |
| `dbDel(table, id)` | id指定削除 |

---

## マイグレーション履歴

| ファイル | 内容 |
|---|---|
| `20250513_ai_usage.sql` | AI使用量テーブル |
| `20260513_enable_rls.sql` | 主要テーブルRLS有効化（tasks/projects/sections/tags/backups/app_settings） |
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

---

## 関連プロダクト（raシリーズ）

| アプリ | URL | リポジトリ | 概要 |
|---|---|---|---|
| Taskra | app.taskra.jp | dat0925/task-app | タスク管理（本リポジトリ） |
| Flowra | flowra.taskra.jp | — | 家計管理PWA |
| Tavera | tavera.taskra.jp | — | 食事計画PWA |
| taskra-web | taskra.jp | dat0925/taskra-web | マーケティングサイト |

---

## デプロイ手順

```bash
# 1. クローン
git clone https://github.com/dat0925/task-app.git
cd task-app

# 2. git設定（クローン直後に必須）
git config user.email "deploy@taskra.jp"
git config user.name "Taskra Deploy"

# 3. 編集後コミット・プッシュ
git add .
git commit -m "feat: 変更内容"
git push https://<PAT>@github.com/dat0925/task-app.git main
```

GitHub PagesのCNAMEは `app.taskra.jp`。pushから反映まで数十秒〜1分程度。
