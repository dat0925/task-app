-- ============================================================================
-- Note用シークレットメモ（E2EE）— task_secret_notes と対になるテーブル
--
-- 鍵素材（secret_key_material）は user_id 単位で共有するため、合言葉・復元コードは
-- タスクのシークレットメモと共通。タスク⇔ノート変換時は、暗号文blobを
-- task_secret_notes と note_secret_notes の間でそのまま移し替えるだけでよい
-- （AES-GCMのblob=iv+ctは対象idに束縛されないため復号不要・ロック中でも移行可能）。
--
-- secret_note は検索・AI・LINE通知の対象外。RLSは所有者のみ。
-- ============================================================================
create table if not exists public.note_secret_notes (
  note_id     text        primary key,
  user_id     text        not null,
  secret_note text        not null,   -- base64(iv + AES-GCM ciphertext)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists note_secret_notes_user_id_idx on public.note_secret_notes (user_id);

alter table public.note_secret_notes enable row level security;
create policy "note_secret_notes: owner only (select)" on public.note_secret_notes for select using (user_id = auth.uid()::text);
create policy "note_secret_notes: owner only (insert)" on public.note_secret_notes for insert with check (user_id = auth.uid()::text);
create policy "note_secret_notes: owner only (update)" on public.note_secret_notes for update using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
create policy "note_secret_notes: owner only (delete)" on public.note_secret_notes for delete using (user_id = auth.uid()::text);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_secret_notes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_secret_notes TO service_role;
