-- =====================================================
-- 2026-10-01 に public スキーマへ作られたバックアップ2テーブルの RLS 有効化
--
-- 経緯: tasks_bk_20261001_merge（2行）/ task_comments_bk_20261001_merge（11行）が
--   RLS 無効のまま public にあり、anon・authenticated に全権限（TRUNCATE まで）が付いていた。
--   public は PostgREST がそのまま公開するため、API 経由で誰でも読み書きできる状態だった
--   （Supabase のセキュリティ診断 rls_disabled_in_public で検出）。
-- 対応: RLS を有効にし、ポリシーは作らない（= API からは誰も読み書きできない。service_role と
--   postgres は RLS をバイパスする）。念のため anon / authenticated の権限も剥奪。
-- 今後: バックアップは public ではなく backup スキーマへ退避する（HANDOVER・第2の脳の方針どおり）。
-- =====================================================
alter table public.tasks_bk_20261001_merge enable row level security;
alter table public.task_comments_bk_20261001_merge enable row level security;
revoke all on public.tasks_bk_20261001_merge from anon, authenticated;
revoke all on public.task_comments_bk_20261001_merge from anon, authenticated;
