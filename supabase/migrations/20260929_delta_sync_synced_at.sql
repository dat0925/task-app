-- 差分同期用の「サーバー時刻の最終更新時刻」列。
-- 背景: 9/1 の fingerprint 対策後も、1件でも変更があると loadAll（約2.7MB）を丸ごと取り直していたため、
-- 無料枠の Egress 5.5GB/月 を使い切って 2026-09-29 に 402 で停止した。
-- 変更のあった行だけを取るには「いつ変わったか」を確実に持つ列が要るが、既存の updated_at は
-- クライアントが書く値（端末の時計依存・notes は text 型）なので使えない。サーバーがトリガーで付ける列を足す。
-- クライアントは synced_at > 前回の最大値 - 余裕幅 の行だけを取る。

alter table public.tasks add column if not exists synced_at timestamptz not null default now();
alter table public.notes add column if not exists synced_at timestamptz not null default now();

create index if not exists tasks_synced_at_idx on public.tasks (synced_at);
create index if not exists notes_synced_at_idx on public.notes (synced_at);

-- クライアントが何を送ってきても、サーバー時刻で上書きする
create or replace function public.touch_synced_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.synced_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function public.touch_synced_at() from public;
revoke all on function public.touch_synced_at() from anon;

drop trigger if exists tasks_touch_synced_at on public.tasks;
create trigger tasks_touch_synced_at before insert or update on public.tasks
  for each row execute function public.touch_synced_at();

drop trigger if exists notes_touch_synced_at on public.notes;
create trigger notes_touch_synced_at before insert or update on public.notes
  for each row execute function public.touch_synced_at();
