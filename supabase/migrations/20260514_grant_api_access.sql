-- =====================================================
-- Supabase 2026-10-30 対応: public スキーマへの明示的GRANT追加
-- 背景: 2026-05-30以降の新規PJ・2026-10-30以降の全PJで
--       publicテーブルへのデータAPIアクセスに明示的GRANTが必要になる
-- =====================================================

-- =====================================================
-- tasks
-- =====================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO service_role;

-- =====================================================
-- projects
-- =====================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO service_role;

-- =====================================================
-- sections
-- =====================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sections TO service_role;

-- =====================================================
-- tags
-- =====================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tags TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tags TO service_role;

-- =====================================================
-- backups
-- =====================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backups TO service_role;

-- =====================================================
-- app_settings
-- =====================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO service_role;

-- =====================================================
-- notes（テーブルが存在する場合）
-- =====================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'notes') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO service_role';
  END IF;
END $$;

-- =====================================================
-- user_plans（Edge FunctionはService Roleで操作、フロントはRLSで制御）
-- =====================================================
GRANT SELECT ON public.user_plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_plans TO service_role;

-- =====================================================
-- ai_usage（Edge FunctionはService Roleで操作）
-- =====================================================
GRANT SELECT ON public.ai_usage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage TO service_role;

-- =====================================================
-- シーケンス（bigserial用）
-- =====================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.sequences WHERE sequence_schema = 'public' AND sequence_name = 'ai_usage_id_seq') THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.ai_usage_id_seq TO authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.ai_usage_id_seq TO service_role';
  END IF;
END $$;
