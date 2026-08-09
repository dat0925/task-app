-- =====================================================
-- Taskra 決済セキュリティ強化: user_plans のプラン改ざん経路を塞ぐ
-- 日付: 2026-08-09
-- 背景:
--   ライブDB確認により、user_plans / ai_usage に対して anon・authenticated へ
--   INSERT/UPDATE/DELETE/TRUNCATE を含む全DML権限が付与されており、防御が
--   RLSポリシー一本に依存している状態だった。さらに INSERT ポリシー
--   "users insert own plan" が plan カラムを制約していなかったため、まだ行を
--   持たない新規ユーザーが匿名APIで {email: 自分, plan:'premium'} を直接 INSERT し、
--   無償でプレミアムにアップグレードできる脆弱性が存在した（ライブで再現確認済み）。
--
--   本マイグレーションはこの経路を塞ぎ、管理者ポリシーを正しい単一アカウントに
--   限定し、未ログイン(anon)からのアクセス権限を剥奪する。
-- 注意:
--   ライブの実ポリシー/権限はこれまでのマイグレーションファイルと乖離していたため、
--   本ファイルが「現時点の正」を表すものとして扱う。
-- =====================================================

-- 1) 自己INSERTは「本人のemail かつ plan='free'」のみ許可（プラン昇格を封じる）
--    正規の初回登録(index.html loadUserPlan)は plan:'free' で INSERT するため影響なし。
drop policy if exists "users insert own plan" on public.user_plans;
create policy "users insert own plan"
  on public.user_plans
  for insert
  to authenticated
  with check (
    email = (auth.jwt() ->> 'email')
    and plan = 'free'
  );

-- 2) 管理者ポリシーを正しい単一アカウント(mstd0520@gmail.com)に限定。
--    以前は個人Gmail 2件(masamune.endo@gmail.com を含む)がハードコードされていた。
drop policy if exists "admin full access" on public.user_plans;
create policy "admin full access"
  on public.user_plans
  for all
  to authenticated
  using ( (auth.jwt() ->> 'email') = 'mstd0520@gmail.com' )
  with check ( (auth.jwt() ->> 'email') = 'mstd0520@gmail.com' );

-- 3) 未ログイン(anon)には user_plans / ai_usage への権限を一切与えない。
--    これらはログインユーザー専用データであり、防御をRLS一本に依存させない。
--    （service_role は別権限のため Edge Function / Webhook には影響しない）
revoke all on public.user_plans from anon;
revoke all on public.ai_usage  from anon;
