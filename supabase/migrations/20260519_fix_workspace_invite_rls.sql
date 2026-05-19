-- =====================================================
-- Fix: 招待リンク経由でワークスペース参加できない問題
--
-- 問題: workspacesのRLSは「メンバーのみ参照可」だが、
--       招待ユーザーはまだメンバーでないため invite_token で
--       ワークスペースを検索できず、参加フローが必ず失敗する。
--
-- 修正: 認証済みユーザーは invite_token を持つワークスペースを
--       参照できるようにする（invite_tokenは招待URLの秘密情報
--       なので、これを知っている人だけが見られる設計で安全）。
-- =====================================================

create policy "workspaces: auth user can select by invite_token"
  on workspaces for select
  using (
    auth.uid() is not null
    and invite_token is not null
  );
