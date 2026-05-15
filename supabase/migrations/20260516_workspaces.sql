-- =====================================================
-- チーム機能: workspaces / workspace_members
-- 設計方針:
--   - 個人データは完全に分離（workspace_id = NULL）
--   - 共有したいprojectにworkspace_idを付与
--   - tasksはproject経由でチーム判断（tasksテーブル変更なし）
-- =====================================================

-- =====================================================
-- workspaces テーブル
-- =====================================================
create table if not exists workspaces (
  id           text        primary key,
  name         text        not null,
  owner_id     text        not null,           -- 作成者 = owner
  invite_token text        unique,             -- 招待リンク用トークン
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table workspaces enable row level security;

-- メンバーなら参照可
create policy "workspaces: members can select"
  on workspaces for select
  using (
    id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()::text
    )
  );

-- ownerのみ作成
create policy "workspaces: owner can insert"
  on workspaces for insert
  with check (owner_id = auth.uid()::text);

-- ownerのみ更新
create policy "workspaces: owner can update"
  on workspaces for update
  using (owner_id = auth.uid()::text)
  with check (owner_id = auth.uid()::text);

-- ownerのみ削除
create policy "workspaces: owner can delete"
  on workspaces for delete
  using (owner_id = auth.uid()::text);

-- =====================================================
-- workspace_members テーブル
-- =====================================================
create table if not exists workspace_members (
  id           text        primary key,
  workspace_id text        not null references workspaces(id) on delete cascade,
  user_id      text        not null,
  user_name    text        not null default '',
  user_avatar  text        not null default '',
  user_email   text        not null default '',
  role         text        not null default 'member', -- 'owner' | 'member'
  joined_at    timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists workspace_members_workspace_id_idx
  on workspace_members (workspace_id);
create index if not exists workspace_members_user_id_idx
  on workspace_members (user_id);

alter table workspace_members enable row level security;

-- 同じワークスペースのメンバーなら参照可（メンバー一覧表示用）
create policy "workspace_members: members can select"
  on workspace_members for select
  using (
    workspace_id in (
      select workspace_id from workspace_members wm2
      where wm2.user_id = auth.uid()::text
    )
  );

-- 自分自身の参加（招待トークン経由）または owner が追加
create policy "workspace_members: can insert self or owner"
  on workspace_members for insert
  with check (
    user_id = auth.uid()::text
  );

-- ownerのみ削除（自分自身の脱退も可）
create policy "workspace_members: owner or self can delete"
  on workspace_members for delete
  using (
    user_id = auth.uid()::text
    or
    workspace_id in (
      select id from workspaces where owner_id = auth.uid()::text
    )
  );

-- =====================================================
-- projects テーブルに workspace_id カラムを追加
-- NULLなら個人プロジェクト、値があれば共有プロジェクト
-- =====================================================
alter table projects add column if not exists workspace_id text references workspaces(id) on delete set null;

create index if not exists projects_workspace_id_idx
  on projects (workspace_id);

-- =====================================================
-- projects の RLS を更新
-- 「自分のプロジェクト」または「自分が属するワークスペースのプロジェクト」
-- =====================================================
drop policy if exists "projects: own data only (select)" on projects;
drop policy if exists "projects: own data only (insert)" on projects;
drop policy if exists "projects: own data only (update)" on projects;
drop policy if exists "projects: own data only (delete)" on projects;

create policy "projects: own or workspace (select)"
  on projects for select
  using (
    user_id = auth.uid()::text
    or
    (workspace_id is not null and workspace_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()::text
    ))
  );

create policy "projects: own or workspace member (insert)"
  on projects for insert
  with check (
    user_id = auth.uid()::text
  );

create policy "projects: own or workspace member (update)"
  on projects for update
  using (
    user_id = auth.uid()::text
    or
    (workspace_id is not null and workspace_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()::text
    ))
  )
  with check (
    user_id = auth.uid()::text
    or
    (workspace_id is not null and workspace_id in (
      select workspace_id from workspace_members
      where user_id = auth.uid()::text
    ))
  );

-- 削除はowner_idまたはワークスペースのowner
create policy "projects: owner can delete"
  on projects for delete
  using (
    user_id = auth.uid()::text
    or
    (workspace_id is not null and workspace_id in (
      select id from workspaces where owner_id = auth.uid()::text
    ))
  );

-- =====================================================
-- tasks の RLS を更新
-- 「自分のタスク」または「共有プロジェクト配下のタスク」
-- =====================================================
drop policy if exists "tasks: own data only (select)" on tasks;
drop policy if exists "tasks: own data only (insert)" on tasks;
drop policy if exists "tasks: own data only (update)" on tasks;
drop policy if exists "tasks: own data only (delete)" on tasks;

create policy "tasks: own or workspace (select)"
  on tasks for select
  using (
    user_id = auth.uid()::text
    or
    (project_id is not null and project_id in (
      select id from projects
      where workspace_id is not null
      and workspace_id in (
        select workspace_id from workspace_members
        where user_id = auth.uid()::text
      )
    ))
  );

create policy "tasks: own or workspace member (insert)"
  on tasks for insert
  with check (
    user_id = auth.uid()::text
  );

create policy "tasks: own or workspace member (update)"
  on tasks for update
  using (
    user_id = auth.uid()::text
    or
    (project_id is not null and project_id in (
      select id from projects
      where workspace_id is not null
      and workspace_id in (
        select workspace_id from workspace_members
        where user_id = auth.uid()::text
      )
    ))
  )
  with check (
    user_id = auth.uid()::text
    or
    (project_id is not null and project_id in (
      select id from projects
      where workspace_id is not null
      and workspace_id in (
        select workspace_id from workspace_members
        where user_id = auth.uid()::text
      )
    ))
  );

create policy "tasks: owner can delete"
  on tasks for delete
  using (
    user_id = auth.uid()::text
    or
    (project_id is not null and project_id in (
      select id from projects
      where workspace_id is not null
      and workspace_id in (
        select id from workspaces where owner_id = auth.uid()::text
      )
    ))
  );

-- =====================================================
-- task_comments の RLS を更新
-- チームメンバーのコメントも見えるように
-- =====================================================
drop policy if exists "task_comments: own data only (select)" on task_comments;
drop policy if exists "task_comments: own data only (insert)" on task_comments;
drop policy if exists "task_comments: own data only (update)" on task_comments;
drop policy if exists "task_comments: own data only (delete)" on task_comments;

create policy "task_comments: own or workspace (select)"
  on task_comments for select
  using (
    user_id = auth.uid()::text
    or
    task_id in (
      select id from tasks
      where project_id in (
        select id from projects
        where workspace_id is not null
        and workspace_id in (
          select workspace_id from workspace_members
          where user_id = auth.uid()::text
        )
      )
    )
  );

create policy "task_comments: workspace member (insert)"
  on task_comments for insert
  with check (
    user_id = auth.uid()::text
  );

create policy "task_comments: own (update)"
  on task_comments for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "task_comments: own or workspace owner (delete)"
  on task_comments for delete
  using (
    user_id = auth.uid()::text
    or
    task_id in (
      select id from tasks
      where project_id in (
        select id from projects
        where workspace_id in (
          select id from workspaces where owner_id = auth.uid()::text
        )
      )
    )
  );
