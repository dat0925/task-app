-- =====================================================
-- Fix: RLS infinite recursion in workspace policies
--
-- 問題: workspace_members の SELECT ポリシーが
--       workspace_members 自身を参照するため、
--       workspaces テーブルへの SELECT が必ず
--       無限再帰 (error 42P17) になる。
--
-- 修正: SECURITY DEFINER 関数でRLSをバイパスして
--       現在ユーザーのworkspace_idを取得し、
--       各ポリシーはその関数を使うように書き直す。
-- =====================================================

-- =====================================================
-- ヘルパー関数: 現在ユーザーが所属するworkspace_idを返す
-- SECURITY DEFINER = RLSをバイパスして直接クエリ実行
-- =====================================================
create or replace function auth_user_workspace_ids()
returns setof text
language sql
security definer
stable
as $$
  select workspace_id
  from workspace_members
  where user_id = auth.uid()::text
$$;

-- =====================================================
-- workspaces: SELECT ポリシーを書き直し
-- =====================================================
drop policy if exists "workspaces: members can select" on workspaces;
create policy "workspaces: members can select"
  on workspaces for select
  using (id in (select auth_user_workspace_ids()));

-- =====================================================
-- workspace_members: SELECT ポリシーを書き直し（再帰を排除）
-- =====================================================
drop policy if exists "workspace_members: members can select" on workspace_members;
create policy "workspace_members: members can select"
  on workspace_members for select
  using (workspace_id in (select auth_user_workspace_ids()));
