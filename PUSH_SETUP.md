# Web Push 通知 セットアップ手順

Taskraのプッシュ通知を有効化するために、以下の手順で環境変数とインフラを準備してください。

## 1. VAPID 鍵ペアの生成

Node.js環境（手元のPC or オンラインのRunkit）で1回だけ実行：

```bash
npx -y web-push generate-vapid-keys
```

出力例：
```
=======================================
Public Key:
BJxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Private Key:
Yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
=======================================
```

**両方を必ず安全な場所に保存**（パスワードマネージャー推奨）。Privateキーが漏れると他人が任意の通知を送れます。

## 2. フロント側にPublicキーを埋め込む

`index.html` の以下の行を編集：

```js
const VAPID_PUBLIC_KEY = '__VAPID_PUBLIC_KEY_PLACEHOLDER__';
```

↓

```js
const VAPID_PUBLIC_KEY = 'BJxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
```

そしてcommit & push。

## 3. Supabase に Secret を登録

Supabase Dashboard → Project Settings → **Edge Functions** → **Secrets** で以下を追加：

| Key | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | 生成した公開鍵 |
| `VAPID_PRIVATE_KEY` | 生成した秘密鍵 |
| `VAPID_SUBJECT` | `mailto:support@taskra.jp` （or 任意のmailto/URL） |
| `CRON_SECRET` | 任意のランダム文字列（cron用の追加検証鍵、`openssl rand -hex 32` で生成） |

`SUPABASE_URL`, `SB_SERVICE_ROLE_KEY`, `SB_ANON_KEY` は既存のものを使用。

## 4. DBマイグレーション適用

Supabase Dashboard → SQL Editor で `supabase/migrations/20260520_push_notifications.sql` の内容を実行。

または Supabase CLI が入っていれば：

```bash
supabase db push
```

## 5. Edge Functions のデプロイ

```bash
supabase functions deploy send-push
supabase functions deploy cron-task-reminders
supabase functions deploy cron-repeat-start
supabase functions deploy notify-mention  # 既存関数も再デプロイ（push追加のため）
```

## 6. GitHub Actions の Secret を登録

GitHub リポジトリ → Settings → Secrets and variables → Actions → **New repository secret**：

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://sfhtvtcmgueystyuhzvd.supabase.co` |
| `SB_SERVICE_ROLE_KEY` | Supabase の service_role キー |

`.github/workflows/push-cron.yml` が15分おきに自動実行されます。

## 7. 動作確認

1. ブラウザでアプリを開きログイン
2. 設定（歯車） → 🔔 プッシュ通知 → 設定 をタップ
3. 「通知を有効にする」をONに → ブラウザの許可ダイアログで「許可」
4. 「🧪 テスト送信」をタップ → 即座に通知が来ればOK
5. タスクの dueAt を今日にセット → 15分以内にcronで期限通知が届く

## iOS 利用者への案内

- iOS 16.4 以降が必須
- **必ずホーム画面に追加したアプリ（PWA）から開く**こと（Safari のタブからは購読不可）
- 左サイドバーの📱QRコードボタン → 「ホーム画面に追加」手順を参照

## トラブルシューティング

| 症状 | 原因/対処 |
|---|---|
| テスト送信が `sent: 0` | 購読端末がない。一度通知をOFFにして再度ON |
| `unauthorized` エラー | VAPID鍵 or service_roleキーの設定漏れ |
| iOSで「有効化」ボタンが反応しない | Safariタブで操作している。ホーム画面アイコンから開き直す |
| Androidで届かない | ブラウザの通知が許可されているか OS の設定を確認 |
| 通知が重複して届く | 端末ごとに購読されている（複数端末で許可した場合は仕様） |
| cron が動かない | GitHub Actions の Secrets と workflows のスケジュールを確認 |

## アーキテクチャ概要

```
[ユーザー端末]
  ├ Service Worker (sw.js) ─── push受信 → showNotification
  └ アプリ ─── 設定UI → pushManager.subscribe() → Supabaseに保存

[Supabase]
  ├ push_subscriptions テーブル
  ├ notification_settings テーブル
  ├ notification_log テーブル（重複防止）
  ├ Edge Function: send-push（共通配信）
  ├ Edge Function: cron-task-reminders（期限通知）
  ├ Edge Function: cron-repeat-start（繰り返し開始）
  └ Edge Function: notify-mention（メンション＋push追加）

[GitHub Actions]
  └ 15分おきに cron-* を呼び出し → 該当ユーザーに配信

[ブラウザのプッシュサーバー (FCM / APNs / Mozilla)]
  └ デバイスへ配信
```
