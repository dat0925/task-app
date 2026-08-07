-- =====================================================================
-- シークレットメモ（E2EE）フェーズ1 スキーマ
--
-- 設計:
--   - ゼロ知識E2EE。サーバー(DB)には暗号文と鍵素材(ラップ済み)のみ保存し、
--     平文・パスフレーズ・リカバリーコード・マスター鍵は一切保存しない。
--   - secret_note は tasks の列にはしない。理由:
--       tasks は共有プロジェクト経由でワークスペースメンバーにも SELECT 許可
--       されており（20260516_workspaces.sql）、アプリは select('*') で全タスクを
--       取得する。列にすると共有相手に暗号文まで渡ってしまう。
--       Postgres の RLS は行単位で列マスクができないため、暗号文の取得すら
--       所有者だけに限定するには「所有者専用テーブルに分離」するのが確実。
--   - よって専用テーブル task_secret_notes を新設し、RLS を user_id = auth.uid()
--     のみ（ワークスペース句なし）にして、所有者以外は行ごと取得不能にする（多層防御）。
--
-- 【重要】secret_note は検索対象外・AIアシスタント連携対象外・LINE通知対象外。
--         これらの機能はこのテーブルを参照しないこと。
-- =====================================================================

-- =====================================================
-- secret_key_material : ユーザーごとの鍵素材（本人のみ read/write）
--   ここに入るのはすべて「ラップ済み or salt」で、単体では復号不可。
--   kdf_salt                    : パスフレーズ鍵導出用 salt (base64)
--   verification_blob           : 既知平文をマスター鍵で暗号化した検証用 (base64 iv+ct)
--   wrapped_master_key          : パスフレーズ鍵でラップしたマスター鍵 (base64 iv+ct)
--   wrapped_master_key_recovery : リカバリーコード鍵でラップしたマスター鍵
--                                 (base64 salt+iv+ct / self-contained)
-- =====================================================
create table if not exists public.secret_key_material (
  user_id                     text        primary key,
  kdf_salt                    text        not null,
  verification_blob           text        not null,
  wrapped_master_key          text        not null,
  wrapped_master_key_recovery text        not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- RLS: 本人のみ（CREATE と同じマイグレーション内で必ず有効化）
alter table public.secret_key_material enable row level security;

create policy "secret_key_material: own only (select)"
  on public.secret_key_material for select
  using (user_id = auth.uid()::text);

create policy "secret_key_material: own only (insert)"
  on public.secret_key_material for insert
  with check (user_id = auth.uid()::text);

create policy "secret_key_material: own only (update)"
  on public.secret_key_material for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "secret_key_material: own only (delete)"
  on public.secret_key_material for delete
  using (user_id = auth.uid()::text);

-- =====================================================
-- task_secret_notes : タスクごとの暗号化シークレットメモ（本人のみ read/write）
--   secret_note : base64(iv + ciphertext)。マスター鍵で暗号化された本文。
--   ※ RLS はワークスペース句を「あえて」持たない。共有タスクであっても
--     所有者以外は暗号文の取得すらできない（tasks 本体の RLS とは独立の防御線）。
-- =====================================================
create table if not exists public.task_secret_notes (
  task_id     text        primary key,   -- 1タスク1シークレットメモ
  user_id     text        not null,      -- 所有者（暗号化した本人）
  secret_note text        not null,      -- base64(iv + ct)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists task_secret_notes_user_id_idx
  on public.task_secret_notes (user_id);

-- RLS: 本人のみ（ワークスペース共有は一切考慮しない ＝ 所有者専用）
alter table public.task_secret_notes enable row level security;

create policy "task_secret_notes: owner only (select)"
  on public.task_secret_notes for select
  using (user_id = auth.uid()::text);

create policy "task_secret_notes: owner only (insert)"
  on public.task_secret_notes for insert
  with check (user_id = auth.uid()::text);

create policy "task_secret_notes: owner only (update)"
  on public.task_secret_notes for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "task_secret_notes: owner only (delete)"
  on public.task_secret_notes for delete
  using (user_id = auth.uid()::text);

-- =====================================================
-- GRANT（2026-10-30対応: public テーブルは明示的GRANTが必要）
--   フロントは authenticated ロール＋RLS で本人のみに制御される。
--   service_role にも付与（管理上）。ただし暗号文なので service_role でも中身は読めない。
-- =====================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.secret_key_material TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.secret_key_material TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_secret_notes  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_secret_notes  TO service_role;
