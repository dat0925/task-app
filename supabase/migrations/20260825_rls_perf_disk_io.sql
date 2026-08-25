-- ============================================================================
-- Disk IO 対策：RLSポリシーの統合と行ごと再評価の排除
--
-- 【背景】
-- Supabase から「ディスクI/O予算が不足」の警告が届いた（2026-08-25）。
-- 調査の結果、DBは25MB・キャッシュヒット率100%で「読み込みが重い」わけではなく、
-- 1リクエストあたりのRLS評価コストが異常に高いことが原因だった。
--
--   * 同じテーブルの同じコマンドに permissive ポリシーが3〜4本重複していた。
--     PostgreSQL は同一コマンドの permissive ポリシーを全部 OR で評価するため、
--     `user_id = auth.uid()` が1行ごとに4回評価されていた。
--     （performance advisor: multiple_permissive_policies 197件）
--   * `auth.uid()` を裸で書いていたため InitPlan 化されず、行ごとに
--     current_setting() + jsonb パースが走っていた。
--     （performance advisor: auth_rls_initplan 131件）
--   * ワークスペース共有の条件がポリシー式の中で public.projects を直接参照して
--     いたため、projects 側のRLSが入れ子で評価され、プラン作成だけで
--     532バッファ・14.9ms かかっていた。
--
-- 実測（変更前・authenticated ロールで EXPLAIN ANALYZE）:
--   select * from tasks         → 0行返すのに 666 バッファ / 12.2ms
--                                 （Rows Removed by Filter: 1816 = ほぼ全行）
--   select task_id from task_comments → Seq Scan・178バッファ
--                                 （Rows Removed by Filter: 1499 = 全行）
--
-- 【この変更でやること】
--   1. ワークスペース経由の可視範囲を SECURITY DEFINER 関数に閉じ込め、
--      ポリシー式から他テーブルのRLS入れ子評価をなくす
--   2. コマンドごとにポリシーを1本へ統合する
--   3. auth.uid() を (select auth.uid()) にして1クエリ1回の評価にする
--
-- 【アクセス範囲は変えない】
-- 統合後の式は「変更前の全ポリシーのOR」と論理的に同一。
-- 全17ユーザー × 8テーブルの可視行IDダイジェストを変更前後で突き合わせて
-- 一致することを確認する（変更前: 5535aaf7fada7657162b87f0b7454bfa / 4444行）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ヘルパー関数
-- ---------------------------------------------------------------------------

-- 既存関数に search_path 固定を追加（security advisor: function_search_path_mutable）。
-- シグネチャは変更しないので、依存しているポリシーはそのまま生きる。
create or replace function public.auth_user_workspace_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select workspace_id
  from public.workspace_members
  where user_id = (select auth.uid())::text
$$;

-- 自分が参加しているワークスペースに属する project の id。
-- SECURITY DEFINER なので projects 側のRLSを再帰的に評価しない。
create or replace function public.auth_workspace_project_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.projects p
  where p.workspace_id is not null
    and p.workspace_id in (
      select wm.workspace_id
      from public.workspace_members wm
      where wm.user_id = (select auth.uid())::text
    )
$$;

-- 上記 project に属する task の id。task_comments の可視判定に使う。
create or replace function public.auth_workspace_task_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
  from public.tasks t
  where t.project_id is not null
    and t.project_id in (select public.auth_workspace_project_ids())
$$;

revoke all on function public.auth_user_workspace_ids()    from public, anon;
revoke all on function public.auth_workspace_project_ids() from public, anon;
revoke all on function public.auth_workspace_task_ids()    from public, anon;
grant execute on function public.auth_user_workspace_ids()    to authenticated;
grant execute on function public.auth_workspace_project_ids() to authenticated;
grant execute on function public.auth_workspace_task_ids()    to authenticated;

-- ---------------------------------------------------------------------------
-- 2. tasks
--    変更前: own tasks(ALL) + own data only(select/insert/update/delete)
--            + own or workspace(select) + own or workspace member(update)
--    実効SELECT = 自分の行 OR ワークスペース共有プロジェクトの行
--    実効DELETE = 自分の行のみ（ワークスペースメンバーは消せない。この差は維持する）
-- ---------------------------------------------------------------------------
drop policy if exists "own tasks"                             on public.tasks;
drop policy if exists "tasks: own data only (select)"          on public.tasks;
drop policy if exists "tasks: own or workspace (select)"       on public.tasks;
drop policy if exists "tasks: own data only (insert)"          on public.tasks;
drop policy if exists "tasks: own data only (update)"          on public.tasks;
drop policy if exists "tasks: own or workspace member (update)" on public.tasks;
drop policy if exists "tasks: own data only (delete)"          on public.tasks;

create policy tasks_select on public.tasks for select to authenticated
using (
  user_id = (select auth.uid())
  or (project_id is not null and project_id in (select public.auth_workspace_project_ids()))
);

create policy tasks_insert on public.tasks for insert to authenticated
with check (user_id = (select auth.uid()));

create policy tasks_update on public.tasks for update to authenticated
using (
  user_id = (select auth.uid())
  or (project_id is not null and project_id in (select public.auth_workspace_project_ids()))
)
with check (
  user_id = (select auth.uid())
  or (project_id is not null and project_id in (select public.auth_workspace_project_ids()))
);

create policy tasks_delete on public.tasks for delete to authenticated
using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. task_comments
--    実効SELECT = 自分のコメント OR ワークスペース共有タスクのコメント
--    それ以外は自分の行のみ（変更前と同じ）
-- ---------------------------------------------------------------------------
drop policy if exists "task_comments: own data only (select)"   on public.task_comments;
drop policy if exists "task_comments: own or workspace (select)" on public.task_comments;
drop policy if exists "task_comments: own data only (insert)"   on public.task_comments;
drop policy if exists "task_comments: own data only (update)"   on public.task_comments;
drop policy if exists "task_comments: own data only (delete)"   on public.task_comments;

create policy task_comments_select on public.task_comments for select to authenticated
using (
  user_id = (select auth.uid())::text
  or task_id in (select public.auth_workspace_task_ids())
);

create policy task_comments_insert on public.task_comments for insert to authenticated
with check (user_id = (select auth.uid())::text);

create policy task_comments_update on public.task_comments for update to authenticated
using (user_id = (select auth.uid())::text)
with check (user_id = (select auth.uid())::text);

create policy task_comments_delete on public.task_comments for delete to authenticated
using (user_id = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- 4. projects
--    実効SELECT/UPDATE = 自分の行 OR ワークスペース共有の行
--    実効INSERT/DELETE = 自分の行のみ
-- ---------------------------------------------------------------------------
drop policy if exists "own projects"                                on public.projects;
drop policy if exists "projects: own data only (select)"             on public.projects;
drop policy if exists "projects: own or workspace (select)"          on public.projects;
drop policy if exists "projects: own data only (insert)"             on public.projects;
drop policy if exists "projects: own data only (update)"             on public.projects;
drop policy if exists "projects: own or workspace member (update)"   on public.projects;
drop policy if exists "projects: own data only (delete)"             on public.projects;

create policy projects_select on public.projects for select to authenticated
using (
  user_id = (select auth.uid())
  or (workspace_id is not null and workspace_id in (select public.auth_user_workspace_ids()))
);

create policy projects_insert on public.projects for insert to authenticated
with check (user_id = (select auth.uid()));

create policy projects_update on public.projects for update to authenticated
using (
  user_id = (select auth.uid())
  or (workspace_id is not null and workspace_id in (select public.auth_user_workspace_ids()))
)
with check (
  user_id = (select auth.uid())
  or (workspace_id is not null and workspace_id in (select public.auth_user_workspace_ids()))
);

create policy projects_delete on public.projects for delete to authenticated
using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. notes / tags / sections
--    いずれも「自分の行のみ」。ALLポリシーとコマンド別ポリシーが重複していただけ。
-- ---------------------------------------------------------------------------
drop policy if exists "users can manage own notes"        on public.notes;
drop policy if exists "notes: own data only (select)"     on public.notes;
drop policy if exists "notes: own data only (insert)"     on public.notes;
drop policy if exists "notes: own data only (update)"     on public.notes;
drop policy if exists "notes: own data only (delete)"     on public.notes;

create policy notes_select on public.notes for select to authenticated
using (user_id = (select auth.uid()));
create policy notes_insert on public.notes for insert to authenticated
with check (user_id = (select auth.uid()));
create policy notes_update on public.notes for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notes_delete on public.notes for delete to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "own tags"                      on public.tags;
drop policy if exists "tags: own data only (select)"  on public.tags;
drop policy if exists "tags: own data only (insert)"  on public.tags;
drop policy if exists "tags: own data only (update)"  on public.tags;
drop policy if exists "tags: own data only (delete)"  on public.tags;

create policy tags_select on public.tags for select to authenticated
using (user_id = (select auth.uid()));
create policy tags_insert on public.tags for insert to authenticated
with check (user_id = (select auth.uid()));
create policy tags_update on public.tags for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy tags_delete on public.tags for delete to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "own sections"                      on public.sections;
drop policy if exists "sections: own data only (select)"  on public.sections;
drop policy if exists "sections: own data only (insert)"  on public.sections;
drop policy if exists "sections: own data only (update)"  on public.sections;
drop policy if exists "sections: own data only (delete)"  on public.sections;

create policy sections_select on public.sections for select to authenticated
using (user_id = (select auth.uid()));
create policy sections_insert on public.sections for insert to authenticated
with check (user_id = (select auth.uid()));
create policy sections_update on public.sections for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy sections_delete on public.sections for delete to authenticated
using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 6. workspaces / workspace_members
--    完全に同一内容のポリシーが2本ずつ並んでいたので1本にまとめる。
-- ---------------------------------------------------------------------------
drop policy if exists "workspaces_select_v2"          on public.workspaces;
drop policy if exists "workspaces_insert"             on public.workspaces;
drop policy if exists "workspaces_owner_can_insert"   on public.workspaces;
drop policy if exists "workspaces_update"             on public.workspaces;
drop policy if exists "workspaces_owner_can_update"   on public.workspaces;
drop policy if exists "workspaces_delete"             on public.workspaces;
drop policy if exists "workspaces_owner_can_delete"   on public.workspaces;

create policy workspaces_select on public.workspaces for select to authenticated
using (
  owner_id = (select auth.uid())::text
  or id in (select public.auth_user_workspace_ids())
);
create policy workspaces_insert on public.workspaces for insert to authenticated
with check (owner_id = (select auth.uid())::text);
create policy workspaces_update on public.workspaces for update to authenticated
using (owner_id = (select auth.uid())::text)
with check (owner_id = (select auth.uid())::text);
create policy workspaces_delete on public.workspaces for delete to authenticated
using (owner_id = (select auth.uid())::text);

drop policy if exists "workspace_members_select"                on public.workspace_members;
drop policy if exists "wsmembers_can_insert_self"               on public.workspace_members;
drop policy if exists "ws_members_delete"                       on public.workspace_members;
drop policy if exists "wsmembers_owner_or_self_can_delete"      on public.workspace_members;

create policy workspace_members_select on public.workspace_members for select to authenticated
using (workspace_id in (select public.auth_user_workspace_ids()));

-- 招待受諾（自分自身の行の追加）だけを許可。変更前と同じ。
create policy workspace_members_insert on public.workspace_members for insert to authenticated
with check (user_id = (select auth.uid())::text);

-- 自分の脱退 OR オーナーによる除名。変更前は EXISTS 版と IN 版が並んでいた（同義）。
create policy workspace_members_delete on public.workspace_members for delete to authenticated
using (
  user_id = (select auth.uid())::text
  or workspace_id in (
    select w.id from public.workspaces w where w.owner_id = (select auth.uid())::text
  )
);

-- ---------------------------------------------------------------------------
-- 7. Realtime の再発防止
--    HANDOVER.md には「publicationも無効化済み」と書かれていたが、実際には
--    supabase_realtime publication に public.sections と public.tags が残っていた。
--    publication にテーブルが載っている限り、クライアントが1つでも
--    postgres_changes を購読した瞬間に Realtime の WAL polling が再開する。
--    （pg_stat_statements で realtime.list_changes が 900,181回・累計87分の実行時間を
--      占めていた。これが過去にDisk IOを枯渇させた原因）
--    public.idol_cheer_messages は別アプリのテーブルなので触らない。
-- ---------------------------------------------------------------------------
alter publication supabase_realtime drop table public.sections;
alter publication supabase_realtime drop table public.tags;
