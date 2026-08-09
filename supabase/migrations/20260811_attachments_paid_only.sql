-- =====================================================
-- 添付ファイル機能を「有料プラン限定」にする
--
-- 方針:
--   - 対象プラン = 有料全部（standard 以上 = plan <> 'free'）
--   - 制限範囲 = アップロード(INSERT)のみ。閲覧(SELECT)/DL/削除は据え置き。
--     → 共有ワークスペースの無料メンバーも、有料メンバーが付けた既存の
--       添付は引き続き閲覧・ダウンロードできる（コスト要因＝保存のみ抑制）。
--   - クライアントの出し分けだけでは anon キー露出前提で API 直叩き回避が
--     可能なため、RLS の INSERT 条件でサーバー側強制する（CLAUDE.md準拠）。
-- =====================================================

-- =====================================================
-- 現在ユーザーが有料プランか判定するヘルパー
--   user_plans は email 主キー・RLS は auth.jwt()->>'email' 基準。
--   SECURITY INVOKER: 本関数は自分の user_plans 行だけを参照し、
--   user_plans の SELECT ポリシー（email = auth.jwt()->>'email'）で
--   本人行は読めるため DEFINER 不要。再帰リスクも無い。
--   → security_definer 系 advisor を出さず、search_path 固定で
--     function_search_path_mutable も回避。
-- =====================================================
create or replace function auth_is_paid()
returns boolean
language sql
security invoker
stable
set search_path = public
as $$
  select exists(
    select 1 from user_plans
    where email = auth.jwt() ->> 'email'
      and plan <> 'free'
  );
$$;

-- anon からは実行不可（未ログインは常に非有料。念のため明示剥奪）
revoke execute on function auth_is_paid() from public;
revoke execute on function auth_is_paid() from anon;
grant execute on function auth_is_paid() to authenticated, service_role;

-- =====================================================
-- attachments INSERT: 従来条件に「有料プラン」を必須化
--   （SELECT/UPDATE/DELETE ポリシーは変更しない）
-- =====================================================
drop policy if exists "attachments: insert own" on attachments;
create policy "attachments: insert own"
  on attachments for insert
  with check (
    auth_is_paid()
    and user_id = auth.uid()
    and (
      (note_id is not null and note_id in (
        select id from notes where user_id = auth.uid()
      ))
      or
      (task_id is not null and (
        task_id in (select id from tasks where user_id = auth.uid())
        or task_id in (
          select id from tasks
          where project_id is not null and project_id in (
            select id from projects
            where workspace_id is not null
              and workspace_id in (select auth_user_workspace_ids())
          )
        )
      ))
    )
  );

-- =====================================================
-- storage.objects INSERT: 有料プランのみ書き込み可
-- =====================================================
drop policy if exists "attachments obj: insert under own prefix" on storage.objects;
create policy "attachments obj: insert under own prefix"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
    and auth_is_paid()
  );
