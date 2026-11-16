-- テーブルにグラフビュー（type = 'chart'）を許可する（2026-11-17、v116）
-- table_views.type の CHECK 制約は 'grid' のみだったため 'chart' を追加する。
-- 個人用 DB には 2026-11-17 に適用済み。会社用へ横展開するときも同じ移行が必要。
ALTER TABLE public.table_views DROP CONSTRAINT table_views_type_check;
ALTER TABLE public.table_views ADD CONSTRAINT table_views_type_check
  CHECK (type = ANY (ARRAY['grid', 'chart']));
