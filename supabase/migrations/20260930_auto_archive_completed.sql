-- 完了から30日たったタスクを毎晩自動でアーカイブする。
-- 背景: アーカイブ済みは通常の同期で読み込まない（20260930_fingerprint_exclude_archived.sql）。
-- 完了済みも放っておくと増え続け、全件同期のたびに運ぶ量が膨らむため、30日で自動アーカイブにする。
-- アーカイブ済みはログブック末尾に件数を出し、スタンダード以上は表示・復元できる。CSV 出力には全プランで含む。
--
-- 対象のルール:
--  1. 親タスク（parent_task_id が NULL）で、完了から30日を過ぎたもの。
--     ただし未完了のサブタスクを持つ親は家族ごと対象外（「2/3 完了」の表示が崩れるため）
--  2. 1 でアーカイブする親の、完了済みサブタスク（親と一緒に隠す）
--  3. 親が存在しない・親がアーカイブ済みのサブタスクで、完了から30日を過ぎたもの
--  未完了の親の下にあるサブタスクは、何日たっても対象にしない（2026-09-30 本人決定）。
--
-- 開始は 2026-10-07（アプリ内で1週間前から告知する）。それまでは何もしない。

create or replace function public.auto_archive_completed()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if now() < timestamptz '2026-10-07 00:00:00+09' then
    return 0;
  end if;

  with parents as (
    select p.id
    from tasks p
    where p.parent_task_id is null
      and p.status = 'completed'
      and p.completed_at < now() - interval '30 days'
      and not exists (
        select 1 from tasks c
        where c.parent_task_id = p.id
          and c.status is distinct from 'completed'
          and c.status is distinct from 'archived'
      )
  ), targets as (
    select id from parents
    union
    select c.id from tasks c join parents p on c.parent_task_id = p.id
    where c.status = 'completed'
    union
    select c.id from tasks c
    where c.parent_task_id is not null
      and c.status = 'completed'
      and c.completed_at < now() - interval '30 days'
      and not exists (
        select 1 from tasks p
        where p.id = c.parent_task_id and p.status is distinct from 'archived'
      )
  )
  update tasks t
     set status = 'archived', updated_at = now()
    from targets
   where t.id = targets.id;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- 利用者からは呼ばせない（cron だけが postgres 権限で実行する）
revoke all on function public.auto_archive_completed() from public;
revoke all on function public.auto_archive_completed() from anon;
revoke all on function public.auto_archive_completed() from authenticated;

-- 毎日 17:30 UTC（日本時間 2:30）
select cron.unschedule('taskra-auto-archive') where exists (select 1 from cron.job where jobname = 'taskra-auto-archive');
select cron.schedule('taskra-auto-archive', '30 17 * * *', $$select public.auto_archive_completed()$$);
