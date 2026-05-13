-- AI利用回数トラッキングテーブル
-- ユーザーごと・月ごとの利用回数を管理する

create table if not exists ai_usage (
  id          bigserial primary key,
  email       text        not null,
  month       text        not null,  -- 'YYYY-MM' 形式
  count       int         not null default 0,
  updated_at  timestamptz not null default now(),
  unique (email, month)
);

-- RLSを有効化（Edge Functionはservice_role keyで操作するので不要だが念のため）
alter table ai_usage enable row level security;

-- Edge Functionからのアクセスはservice_roleで行うためRLSポリシー不要
-- ユーザー自身が自分の利用回数を参照できるポリシー（任意）
create policy "Users can view own usage"
  on ai_usage for select
  using (email = auth.jwt() ->> 'email');
