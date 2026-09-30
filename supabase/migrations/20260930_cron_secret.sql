-- cron から呼ぶ Edge Function を「合言葉」付きでしか実行できないようにする。
-- 背景: cron-plan-reconcile / cron-cleanup-notifications は verify_jwt=false で、関数内でも認証しておらず、
-- URL を知っていれば誰でも実行できた。cron-plan-reconcile は応答にプランを直した利用者のメールアドレスを返していた。
-- cron.job の command には service_role を名乗るトークンがべた書きされていたが、署名が anon キーのものと同じで
-- 正しいトークンではなく、実際には何の役にも立っていなかった（2026-09-30 確認）。
--
-- 仕組み:
--  1. 合言葉は Vault（vault.secrets）に置く。値はここで乱数生成し、リポジトリにも会話にも出さない
--  2. cron は vault.decrypted_secrets から読んで x-cron-secret ヘッダーに付ける
--  3. 関数は service role で check_cron_secret() を呼び、一致しなければ 401 を返す
-- 合言葉を替えたいときは vault.update_secret で値を変えるだけでよい（cron も関数も毎回 Vault を読む）。

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret', 'cron から Edge Function を呼ぶときの合言葉')
where not exists (select 1 from vault.secrets where name = 'cron_secret');

create or replace function public.check_cron_secret(p text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p, '') <> ''
     and exists (select 1 from vault.decrypted_secrets where name = 'cron_secret' and decrypted_secret = p);
$$;

revoke all on function public.check_cron_secret(text) from public;
revoke all on function public.check_cron_secret(text) from anon;
revoke all on function public.check_cron_secret(text) from authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

-- cron を合言葉つきで登録し直す（同じ名前で schedule すると上書きされる）。べた書きのトークンはここで消える
select cron.schedule('cleanup-notifications-daily', '0 2 * * *', $cmd$
  select net.http_post(
    url := 'https://sfhtvtcmgueystyuhzvd.supabase.co/functions/v1/cron-cleanup-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
$cmd$);

select cron.schedule('plan-reconcile-daily', '0 18 * * *', $cmd$
  select net.http_post(
    url := 'https://sfhtvtcmgueystyuhzvd.supabase.co/functions/v1/cron-plan-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
$cmd$);
