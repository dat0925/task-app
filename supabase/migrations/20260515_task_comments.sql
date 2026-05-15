-- =====================================================
-- task_comments テーブル
-- タスクへのコメント機能
-- パフォーマンス設計:
--   - 起動時には読み込まない（ドロワー開時にtask_id指定で取得）
--   - task_id + created_at のインデックスで高速検索
-- =====================================================

create table if not exists task_comments (
  id          text        primary key,
  task_id     text        not null,
  user_id     text        not null,
  user_name   text        not null default '',
  user_avatar text        not null default '',
  body        text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- インデックス: task_idごとの取得を高速化
create index if not exists task_comments_task_id_idx
  on task_comments (task_id, created_at);

-- インデックス: ユーザーごとの取得
create index if not exists task_comments_user_id_idx
  on task_comments (user_id);

-- RLS有効化
alter table task_comments enable row level security;

-- 自分のコメントは読める
-- ＋ 同じtask_idを持つタスクのuser_idが自分であれば他者コメントも読める
-- ※ 現在は個人利用のみなのでuser_idが自分のもののみ表示で十分
create policy "task_comments: own data only (select)"
  on task_comments for select
  using (user_id = auth.uid()::text);

create policy "task_comments: own data only (insert)"
  on task_comments for insert
  with check (user_id = auth.uid()::text);

create policy "task_comments: own data only (update)"
  on task_comments for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "task_comments: own data only (delete)"
  on task_comments for delete
  using (user_id = auth.uid()::text);
