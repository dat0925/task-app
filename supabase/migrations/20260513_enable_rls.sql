-- =====================================================
-- RLS（行レベルセキュリティ）有効化
-- 対象: tasks, projects, sections, tags, backups, app_settings
-- 各テーブルで「自分のデータだけ読み書きできる」ポリシーを設定
-- =====================================================

-- =====================================================
-- tasks
-- =====================================================
alter table tasks enable row level security;

create policy "tasks: own data only (select)"
  on tasks for select
  using (user_id = auth.uid()::text);

create policy "tasks: own data only (insert)"
  on tasks for insert
  with check (user_id = auth.uid()::text);

create policy "tasks: own data only (update)"
  on tasks for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "tasks: own data only (delete)"
  on tasks for delete
  using (user_id = auth.uid()::text);

-- =====================================================
-- projects
-- =====================================================
alter table projects enable row level security;

create policy "projects: own data only (select)"
  on projects for select
  using (user_id = auth.uid()::text);

create policy "projects: own data only (insert)"
  on projects for insert
  with check (user_id = auth.uid()::text);

create policy "projects: own data only (update)"
  on projects for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "projects: own data only (delete)"
  on projects for delete
  using (user_id = auth.uid()::text);

-- =====================================================
-- sections
-- =====================================================
alter table sections enable row level security;

create policy "sections: own data only (select)"
  on sections for select
  using (user_id = auth.uid()::text);

create policy "sections: own data only (insert)"
  on sections for insert
  with check (user_id = auth.uid()::text);

create policy "sections: own data only (update)"
  on sections for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "sections: own data only (delete)"
  on sections for delete
  using (user_id = auth.uid()::text);

-- =====================================================
-- tags
-- =====================================================
alter table tags enable row level security;

create policy "tags: own data only (select)"
  on tags for select
  using (user_id = auth.uid()::text);

create policy "tags: own data only (insert)"
  on tags for insert
  with check (user_id = auth.uid()::text);

create policy "tags: own data only (update)"
  on tags for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "tags: own data only (delete)"
  on tags for delete
  using (user_id = auth.uid()::text);

-- =====================================================
-- backups
-- =====================================================
alter table backups enable row level security;

create policy "backups: own data only (select)"
  on backups for select
  using (user_id = auth.uid()::text);

create policy "backups: own data only (insert)"
  on backups for insert
  with check (user_id = auth.uid()::text);

create policy "backups: own data only (update)"
  on backups for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "backups: own data only (delete)"
  on backups for delete
  using (user_id = auth.uid()::text);

-- =====================================================
-- app_settings
-- ※ app_settingsはuser_idカラムがない場合はkeyで管理している可能性あり
--   実際のスキーマに合わせて調整が必要
-- =====================================================
alter table app_settings enable row level security;

-- app_settingsにuser_idカラムがある場合
create policy "app_settings: own data only (select)"
  on app_settings for select
  using (user_id = auth.uid()::text);

create policy "app_settings: own data only (insert)"
  on app_settings for insert
  with check (user_id = auth.uid()::text);

create policy "app_settings: own data only (update)"
  on app_settings for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "app_settings: own data only (delete)"
  on app_settings for delete
  using (user_id = auth.uid()::text);

-- =====================================================
-- notes（存在する場合）
-- =====================================================
-- alter table notes enable row level security;
-- 
-- create policy "notes: own data only (select)"   on notes for select   using (user_id = auth.uid()::text);
-- create policy "notes: own data only (insert)"   on notes for insert   with check (user_id = auth.uid()::text);
-- create policy "notes: own data only (update)"   on notes for update   using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
-- create policy "notes: own data only (delete)"   on notes for delete   using (user_id = auth.uid()::text);
