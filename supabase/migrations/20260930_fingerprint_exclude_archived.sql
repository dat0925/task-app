-- sync_fingerprint の tasks 件数からアーカイブ済みを除く。
-- 背景: アーカイブ済みタスク（2026-09-30 時点で 1,888件・約1.3MB＝tasks の約6割）は画面のどこにも出ないのに、
-- 全件同期のたびに転送していた。クライアントはアーカイブ済みを取らなくなったため、
-- 件数もそれに合わせないと差分同期の件数照合が毎回食い違い、id の全件取得が走り続ける。
-- 最終更新時刻（max(updated_at)）はアーカイブ済みも含めて見る。アーカイブした操作そのものを変化として検知するため。

create or replace function public.sync_fingerprint()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'tasks',      (select count(*) filter (where status is distinct from 'archived')::text || '/' || coalesce(max(updated_at)::text, '') from tasks),
    'projects',   (select count(*)::text || '/' || coalesce(max(updated_at)::text, '') from projects),
    'notes',      (select count(*)::text || '/' || coalesce(max(updated_at)::text, '') from notes),
    'tags',       (select count(*)::text from tags),
    'comments',   (select count(*)::text || '/' || coalesce(max(coalesce(updated_at, created_at))::text, '') from task_comments),
    'workspaces', (select count(*)::text || '/' || coalesce(max(updated_at)::text, '') from workspaces),
    'members',    (select count(*)::text || '/' || coalesce(max(joined_at)::text, '') from workspace_members)
  );
$$;

revoke all on function public.sync_fingerprint() from public;
revoke all on function public.sync_fingerprint() from anon;
grant execute on function public.sync_fingerprint() to authenticated;
