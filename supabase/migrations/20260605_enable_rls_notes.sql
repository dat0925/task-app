-- =====================================================
-- notes テーブルの RLS 有効化
-- 背景: 20260513_enable_rls.sql でコメントアウトされたまま
--       だったため、全ユーザーのノートが見える状態だった
-- 対応: user_id = auth.uid() のポリシーで自分のデータのみに制限
-- =====================================================

-- user_id カラムが存在しない場合は追加（念のため）
alter table notes add column if not exists user_id text;

-- user_id が null のレコードは孤立データなので確認用に件数だけ出す
-- （削除はしない。必要なら手動で確認すること）
-- select count(*) from notes where user_id is null;

-- RLS 有効化
alter table notes enable row level security;

-- SELECT: 自分のノートのみ
create policy "notes: own data only (select)"
  on notes for select
  using (user_id = auth.uid()::text);

-- INSERT: 自分の user_id でのみ挿入可
create policy "notes: own data only (insert)"
  on notes for insert
  with check (user_id = auth.uid()::text);

-- UPDATE: 自分のノートのみ更新可
create policy "notes: own data only (update)"
  on notes for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

-- DELETE: 自分のノートのみ削除可
create policy "notes: own data only (delete)"
  on notes for delete
  using (user_id = auth.uid()::text);
