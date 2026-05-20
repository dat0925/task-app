-- ===== Web Push 通知 関連テーブル =====

-- 1) 購読情報（端末ごと）
create table if not exists push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index if not exists idx_push_subs_user on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;

drop policy if exists push_subs_select_own on push_subscriptions;
create policy push_subs_select_own on push_subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists push_subs_insert_own on push_subscriptions;
create policy push_subs_insert_own on push_subscriptions
  for insert with check (auth.uid() = user_id);

drop policy if exists push_subs_update_own on push_subscriptions;
create policy push_subs_update_own on push_subscriptions
  for update using (auth.uid() = user_id);

drop policy if exists push_subs_delete_own on push_subscriptions;
create policy push_subs_delete_own on push_subscriptions
  for delete using (auth.uid() = user_id);

-- 2) ユーザーごとの通知設定
create table if not exists notification_settings (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  push_enabled       boolean not null default false,
  due_reminder       boolean not null default true,
  due_minutes_before integer not null default 30,
  mention_notify     boolean not null default true,
  repeat_start       boolean not null default true,
  quiet_start        text,
  quiet_end          text,
  updated_at         timestamptz not null default now()
);

alter table notification_settings enable row level security;

drop policy if exists notif_settings_select_own on notification_settings;
create policy notif_settings_select_own on notification_settings
  for select using (auth.uid() = user_id);

drop policy if exists notif_settings_insert_own on notification_settings;
create policy notif_settings_insert_own on notification_settings
  for insert with check (auth.uid() = user_id);

drop policy if exists notif_settings_update_own on notification_settings;
create policy notif_settings_update_own on notification_settings
  for update using (auth.uid() = user_id);

-- 3) 送信ログ（重複送信防止用）
create table if not exists notification_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,
  ref_id      text not null,
  sent_at     timestamptz not null default now(),
  unique(user_id, kind, ref_id)
);
create index if not exists idx_notif_log_user_kind on notification_log(user_id, kind);
create index if not exists idx_notif_log_sent_at on notification_log(sent_at);

alter table notification_log enable row level security;
-- service_roleのみアクセス想定。一般ユーザーは触らない（policyを作らない＝全拒否）

-- 4) 古いログの自動削除関数（30日より前）
create or replace function purge_old_notification_log() returns void language sql as $$
  delete from notification_log where sent_at < now() - interval '30 days';
$$;
