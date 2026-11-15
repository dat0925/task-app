-- テーブル機能（タスクとは別の汎用の表。Airtable／Notion のデータベースと同じ形）【2026-11-15 追加】
-- 稼働中の DB へは db/migrations/20261115_tables_feature.sql（同じ内容）を apply-sql.mjs で当てる。
--
-- 形：tables（表）→ table_fields（列）→ table_records（行）＋ table_views（表示の設定）
--   - 行の値は table_records.values（jsonb）に、列の id をキーにして入れる。列名をキーにしない（列名を変えても値が迷子にならない）
--   - 動的に実テーブルを作る方式や、セル1つを1行にする方式（EAV）は採らない。移行・保守・書き出しが重くなるため
--   - secret 型の列の値は values に入れない。table_record_secrets に暗号文だけを置く。
--     暗号化はブラウザの中で、シークレットメモと同じマスター鍵（secret_key_material）を使う（E2EE）。
--     DB・バックアップ・MCP には平文が出ない。cipher は base64(iv + 暗号文)（シークレットメモと同じ形）

create table if not exists public.tables (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  icon text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tables_user_idx on public.tables (user_id, sort_order);

create table if not exists public.table_fields (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  name text not null,
  type text not null check (type = any (array['text','long_text','number','date','checkbox','select','multi_select','url','email','secret'])),
  options jsonb not null default '{}'::jsonb,
  is_primary boolean not null default false,
  is_required boolean not null default false,
  sort_order integer not null default 0,
  width integer not null default 200,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists table_fields_table_idx on public.table_fields (table_id, sort_order);
-- 主列は1つの表に1つだけ
create unique index if not exists table_fields_one_primary on public.table_fields (table_id) where is_primary;

create table if not exists public.table_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  values jsonb not null default '{}'::jsonb,
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists table_records_table_idx on public.table_records (table_id, sort_order);

create table if not exists public.table_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  name text not null default 'グリッド',
  type text not null default 'grid' check (type = any (array['grid'])),
  config jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists table_views_table_idx on public.table_views (table_id, sort_order);

create table if not exists public.table_record_secrets (
  record_id uuid not null references public.table_records(id) on delete cascade,
  field_id uuid not null references public.table_fields(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  cipher text not null,
  updated_at timestamptz not null default now(),
  primary key (record_id, field_id)
);
create index if not exists table_record_secrets_user_idx on public.table_record_secrets (user_id);

-- 権限と RLS（04 と同じ方針：本人の行だけ。anon には何も見せない）
do $$
declare
  t text;
begin
  foreach t in array array['tables','table_fields','table_records','table_views','table_record_secrets']
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end
$$;

-- PostgREST に新しい表を知らせる
notify pgrst, 'reload schema';
