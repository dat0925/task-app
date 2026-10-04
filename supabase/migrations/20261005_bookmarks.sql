-- =====================================================
-- ブックマークビュー: bookmark_profiles / bookmarks / bookmark_sync_tokens
--
-- 経緯:
--   この3テーブルは、このマイグレーションより前に本番DBへ直接作られていた
--   （画面側のコード・Edge Function・マイグレーションは未コミットのまま止まっていた）。
--   2026-10-05 に定義を調べ、リポジトリに記録するためここへ起こした。
--   本番では create table if not exists が何もしない（冪等）ので、
--   実際に効くのは末尾の「クライアントから書けるようにする」部分だけ。
--
-- 設計:
--   - bookmark_profiles = Chrome のプロファイル（＝Googleアカウント）1つ。
--       source は 'html'（エクスポートHTMLの取り込み）か 'sync'（Chrome拡張での自動同期・未実装）。
--       HTML取り込みでは profile_key = 'html:' || 小文字化したラベル とし、
--       同じラベルで取り込み直したら、そのプロファイルの中身を丸ごと入れ替える。
--       content_hash が同じなら何もしない。
--   - bookmarks = ブックマーク本体。folder は階層を配列で持つ（'/' を含む名前でも壊れない）。
--       pos はエクスポートHTML内の出現順（Chrome 上の並びの再現用）。
--   - bookmark_sync_tokens = 拡張機能用の同期トークン（ハッシュのみ保存）。今回は触らない。
--       発行は本番にだけ存在する RPC `bookmark_token_create(p_label text)`（security definer・
--       search_path 固定・本人のみ・1人10個まで・平文トークンは戻り値で1回だけ返す）。
--       このファイルでは再定義しない（本番の定義が正本。変えるときはここへ起こすこと）。
--       拡張機能から bookmarks へ書く Edge Function は未作成。作るときは source='sync' で書く。
--   - 件数が数千になりうるため、アプリの全体同期（差分同期・fingerprint）には混ぜない。
--     ブックマークビューを開いたときだけ取得する（Egress 対策）。
--   - CLAUDE.md 規約に従い、全テーブルで RLS 有効＋本人のみ。anon には何も与えない。
-- =====================================================

create table if not exists public.bookmark_profiles (
  user_id        uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  profile_key    text        not null,
  profile_name   text        not null default '',
  account_email  text        not null default '',
  source         text        not null check (source in ('sync', 'html')),
  device         text        not null default '',
  item_count     integer     not null default 0,
  excluded_count integer     not null default 0,
  content_hash   text        not null default '',
  synced_at      timestamptz not null default now(),
  checked_at     timestamptz not null default now(),
  primary key (user_id, profile_key)
);

create table if not exists public.bookmarks (
  id          bigint      generated always as identity primary key,
  user_id     uuid        not null default auth.uid(),
  profile_key text        not null,
  title       text        not null default '',
  url         text        not null,
  folder      text[]      not null default '{}',
  pos         integer     not null default 0,
  added_at    timestamptz,
  foreign key (user_id, profile_key)
    references public.bookmark_profiles (user_id, profile_key) on delete cascade
);

create index if not exists bookmarks_user_profile_idx
  on public.bookmarks (user_id, profile_key, pos);

create table if not exists public.bookmark_sync_tokens (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  token_hash   text        not null unique,
  label        text        not null default '',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

alter table public.bookmark_profiles    enable row level security;
alter table public.bookmarks            enable row level security;
alter table public.bookmark_sync_tokens enable row level security;

-- user_id を送り忘れても本人になるようにする（RLS の with check が最終防衛線）
alter table public.bookmarks alter column user_id set default auth.uid();

-- ポリシーは create policy が冪等でないので、無いものだけ作る
do $$
declare
  p record;
begin
  for p in select * from (values
    ('bookmark_profiles',    'bookmark_profiles_select', 'select', 'using (user_id = auth.uid())'),
    ('bookmark_profiles',    'bookmark_profiles_delete', 'delete', 'using (user_id = auth.uid())'),
    ('bookmark_sync_tokens', 'bookmark_sync_tokens_select', 'select', 'using (user_id = auth.uid())'),
    ('bookmark_sync_tokens', 'bookmark_sync_tokens_delete', 'delete', 'using (user_id = auth.uid())'),
    ('bookmarks',            'bookmarks_select', 'select', 'using (user_id = auth.uid())'),
    ('bookmarks',            'bookmarks_delete', 'delete', 'using (user_id = auth.uid())'),
    -- ↓ 2026-10-05 追加: HTML取り込みをブラウザから直接書けるようにする。本人の行だけ
    ('bookmark_profiles',    'bookmark_profiles_insert', 'insert', 'with check (user_id = auth.uid())'),
    ('bookmark_profiles',    'bookmark_profiles_update', 'update', 'using (user_id = auth.uid()) with check (user_id = auth.uid())'),
    ('bookmarks',            'bookmarks_insert', 'insert', 'with check (user_id = auth.uid())')
  ) as t(tbl, pol, cmd, body)
  loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = p.tbl and policyname = p.pol) then
      execute format('create policy %I on public.%I for %s %s', p.pol, p.tbl, p.cmd, p.body);
    end if;
  end loop;
end $$;

-- テーブルレベル権限: authenticated / service_role のみ（anon 剥奪）
revoke all on public.bookmark_profiles, public.bookmarks, public.bookmark_sync_tokens from anon;
-- 同期トークンはブラウザから読ませない（ハッシュでも見せない）。失効（削除）だけ許す。既存の設計どおり
grant delete on public.bookmark_sync_tokens to authenticated;
grant select, insert, update, delete on public.bookmark_profiles to authenticated;
grant select, insert, delete on public.bookmarks to authenticated;
grant all on public.bookmark_profiles, public.bookmarks, public.bookmark_sync_tokens to service_role;
