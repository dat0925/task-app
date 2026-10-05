-- =====================================================
-- セキュリティ診断（function_search_path_mutable / anon_security_definer_function_executable）への低リスク対応
--
-- 1) search_path 未設定だった5関数に public を固定（呼び出し元に依存した名前解決を避ける）。
--    振る舞いは変わらない（いずれも public のテーブルだけを参照している）。
-- 2) portal_today_tasks は、ログイン済みのポータルからしか呼ばれない。未ログイン(anon)の実行権限を外す。
--    ※ portal_is_allowed は RLS ポリシーの判定にも使われ PUBLIC にも付与されているため、今回は触らない
--      （外すと未ログイン時の挙動が「空」から「権限エラー」に変わりうる）。
--
-- 触っていないもの（要設計）: find_household_by_code（Tavera）は未ログインでも世帯のIDと名前を引ける。
--    詳細と方針は第2の脳の開発ナレッジを参照。公開されるこのファイルには手口を書かない。
-- =====================================================
alter function public.find_household_by_code(text)        set search_path = public;
alter function public.get_my_household_id()               set search_path = public;
alter function public.get_workspace_by_invite_token(text) set search_path = public;
alter function public.purge_old_notification_log()        set search_path = public;
alter function public.portal_pages_touch()                set search_path = public;

revoke execute on function public.portal_today_tasks() from anon;
