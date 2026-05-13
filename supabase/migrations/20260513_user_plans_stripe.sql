-- user_plans テーブルの作成（存在しない場合）
create table if not exists user_plans (
  email              text primary key,
  plan               text not null default 'free',
  stripe_customer_id text,
  updated_at         timestamptz not null default now()
);

-- stripe_customer_id カラムの追加（既存テーブルへの追加）
alter table user_plans
  add column if not exists stripe_customer_id text;

-- stripe_customer_id で高速検索できるようにインデックスを追加
create index if not exists user_plans_stripe_customer_id_idx
  on user_plans (stripe_customer_id);

-- RLS
alter table user_plans enable row level security;

create policy if not exists "Users can read own plan"
  on user_plans for select
  using (email = auth.jwt() ->> 'email');
