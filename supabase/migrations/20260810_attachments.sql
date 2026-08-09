-- =====================================================
-- 添付ファイル機能: attachments テーブル + Storage バケット + RLS
--
-- 設計方針:
--   - 画像/ファイルの実体は Supabase Storage の private バケット
--     'attachments' に保存し、メタ情報のみ本テーブルで管理する。
--   - タスク添付は「共有プロジェクト配下」なら他メンバーも閲覧可
--     （tasks の可視性ルールをミラー。auth_user_workspace_ids() 使用）。
--   - ノート添付は個人のみ（notes にワークスペース概念が無いため）。
--   - user_id は tasks/notes と同じ uuid 型。auth.uid() と直接比較する。
--   - CLAUDE.md 規約に従い、CREATE と RLS を同一マイグレーションに記述。
-- =====================================================

-- =====================================================
-- attachments テーブル
--   task_id / note_id は両方 nullable。XOR 制約で必ず片方だけ紐付く。
-- =====================================================
create table if not exists attachments (
  id           text        primary key,               -- アプリ側 uid() 生成
  task_id      text        references tasks(id) on delete cascade,
  note_id      text        references notes(id) on delete cascade,
  user_id      uuid        not null default auth.uid(),-- アップロード者 = auth.uid()
  file_name    text        not null,                  -- 元のファイル名（表示用）
  mime_type    text        not null default '',
  size_bytes   bigint      not null default 0,
  storage_path text        not null unique,           -- バケット内オブジェクト名
  kind         text        not null default 'file',   -- 'image' | 'file'
  width        int,                                   -- 画像のみ（任意）
  height       int,
  created_at   timestamptz not null default now(),
  constraint attachments_parent_xor
    check (num_nonnulls(task_id, note_id) = 1)         -- 必ず片方だけ
);

create index if not exists attachments_task_id_idx on attachments(task_id, created_at);
create index if not exists attachments_note_id_idx on attachments(note_id, created_at);
create index if not exists attachments_user_id_idx on attachments(user_id);

-- テーブルレベル権限: authenticated / service_role のみ（anon 剥奪）
revoke all on attachments from anon;
grant select, insert, update, delete on attachments to authenticated;
grant all on attachments to service_role;

-- =====================================================
-- attachments RLS
-- =====================================================
alter table attachments enable row level security;

-- SELECT: 自分の添付 or 共有プロジェクト配下タスクの添付
create policy "attachments: own or workspace task (select)"
  on attachments for select
  using (
    user_id = auth.uid()
    or (
      task_id is not null and task_id in (
        select id from tasks
        where project_id is not null and project_id in (
          select id from projects
          where workspace_id is not null
            and workspace_id in (select auth_user_workspace_ids())
        )
      )
    )
  );

-- INSERT: 自分名義で、対象が「自分のノート」or「自分の/共有タスク」であること
create policy "attachments: insert own"
  on attachments for insert
  with check (
    user_id = auth.uid()
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

-- UPDATE: 自分の添付のみ
create policy "attachments: update own"
  on attachments for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- DELETE: 自分の添付 or 共有タスクのワークスペース owner
create policy "attachments: delete own or ws owner"
  on attachments for delete
  using (
    user_id = auth.uid()
    or (task_id is not null and task_id in (
      select id from tasks
      where project_id is not null and project_id in (
        select id from projects
        where workspace_id in (select id from workspaces where owner_id = auth.uid()::text)
      )
    ))
  );

-- =====================================================
-- Storage バケット（private）+ サイズ/MIME 制限
--   パス命名規約: {user_id}/{attachment_id}/{filename}
-- =====================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments', 'attachments', false,
  26214400,  -- 25MB/ファイル（バケットレベルの一次防御）
  array[
    'image/png','image/jpeg','image/gif','image/webp','image/heic','image/heif',
    'application/pdf',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain','text/csv',
    'application/zip','application/octet-stream'
  ]
)
on conflict (id) do nothing;

-- =====================================================
-- storage.objects RLS（バケット 'attachments' のみ対象）
--   委譲原則: SELECT/DELETE のサブクエリは attachments 側 RLS を受けるため、
--   共有可視性を storage 側に再実装せず attachments に委譲できる。
-- =====================================================

-- INSERT: 自分の uid プレフィックス配下にのみ書ける
create policy "attachments obj: insert under own prefix"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- SELECT: 自分がアップロードした実体 or 「自分に見える attachments 行」が指す実体
create policy "attachments obj: select own or visible"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from attachments a where a.storage_path = name)
    )
  );

-- DELETE: 自分のプレフィックス配下、または削除権のある共有添付
create policy "attachments obj: delete own or ws owner"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from attachments a
        where a.storage_path = name
          and a.task_id is not null
          and a.task_id in (
            select id from tasks where project_id is not null and project_id in (
              select id from projects
              where workspace_id in (select id from workspaces where owner_id = auth.uid()::text)
            )
          )
      )
    )
  );
