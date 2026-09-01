-- Egress削減のための軽量RPC 2本。
-- どちらも SECURITY INVOKER（既定）なので、呼び出したユーザーのRLSがそのまま適用される。
-- 新規テーブルは作らないため、RLSの状態は既存のまま変わらない。
-- 背景と経緯は HANDOVER.md「Supabase無料枠のEgress超過と、全件ポーリングの是正」を参照。

-- 1) 同期用フィンガープリント。
--    各テーブルの「件数」と「最終更新時刻」だけを1回で返す。
--    クライアントは前回値と一致していれば全件フェッチ（loadAll）をスキップできる。
--    tags は updated_at を持たないため件数のみ。
create or replace function public.sync_fingerprint()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'tasks',      (select count(*)::text || '/' || coalesce(max(updated_at)::text, '') from tasks),
    'projects',   (select count(*)::text || '/' || coalesce(max(updated_at)::text, '') from projects),
    'notes',      (select count(*)::text || '/' || coalesce(max(updated_at)::text, '') from notes),
    'tags',       (select count(*)::text from tags),
    'comments',   (select count(*)::text || '/' || coalesce(max(coalesce(updated_at, created_at))::text, '') from task_comments),
    'workspaces', (select count(*)::text || '/' || coalesce(max(updated_at)::text, '') from workspaces),
    'members',    (select count(*)::text || '/' || coalesce(max(joined_at)::text, '') from workspace_members)
  );
$$;

-- 2) タスク別コメント件数。
--    従来はバッジ表示のために task_comments を全行（select=task_id）取得していた。
--    集計をDB側で行い、コメントが1件以上あるタスクの行だけを返す。
create or replace function public.task_comment_counts()
returns table(task_id text, cnt bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select tc.task_id, count(*)::bigint from task_comments tc group by tc.task_id;
$$;

-- 未認証（anon）からは呼べないようにする。ログイン済みユーザーのみ実行可。
revoke all on function public.sync_fingerprint() from public;
revoke all on function public.sync_fingerprint() from anon;
revoke all on function public.task_comment_counts() from public;
revoke all on function public.task_comment_counts() from anon;
grant execute on function public.sync_fingerprint() to authenticated;
grant execute on function public.task_comment_counts() to authenticated;
