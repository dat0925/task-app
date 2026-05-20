// Taskra - cron-task-reminders edge function
// GitHub Actions から定期的に呼ばれて、期限が近いタスクのリマインダーを送信する
//
// 呼び出し: POST /functions/v1/cron-task-reminders
//   header: Authorization: Bearer <SB_SERVICE_ROLE_KEY>
//   (CRON_SECRET をbodyに含めると追加検証可能)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY     = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY    = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT        = Deno.env.get('VAPID_SUBJECT') || 'mailto:support@taskra.jp';
const CRON_SECRET          = Deno.env.get('CRON_SECRET') || '';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

async function sendPush(sb: any, userId: string, payload: any) {
  const { data: subs } = await sb
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  if (!subs?.length) return { sent: 0 };
  const body = JSON.stringify(payload);
  let sent = 0;
  const dead: string[] = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body
      );
      sent++;
    } catch (err: any) {
      const code = err?.statusCode;
      if (code === 410 || code === 404) dead.push(s.id);
    }
  }
  if (dead.length) await sb.from('push_subscriptions').delete().in('id', dead);
  return { sent };
}

// "HH:MM" の文字列を分換算
function hmToMin(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}
// 現在時刻 (JST) が quiet 時間に含まれるか
function inQuietHours(now: Date, qs?: string | null, qe?: string | null): boolean {
  const qsM = hmToMin(qs), qeM = hmToMin(qe);
  if (qsM == null || qeM == null) return false;
  // JST(=UTC+9)で判定
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const cur = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  if (qsM === qeM) return false;
  if (qsM < qeM) return cur >= qsM && cur < qeM;       // 例: 09:00-22:00
  return cur >= qsM || cur < qeM;                       // 例: 22:00-07:00（日跨ぎ）
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // 認証: service_role キー必須
    const auth = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
    if (auth !== SUPABASE_SERVICE_KEY) {
      // または CRON_SECRET ヘッダー
      const cs = req.headers.get('X-Cron-Secret') || '';
      if (!CRON_SECRET || cs !== CRON_SECRET) {
        return json({ error: 'unauthorized' }, 401);
      }
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const tomorrowDate = new Date(now); tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

    // 通知有効＆期限リマインダーONのユーザーを取得
    const { data: users, error: uErr } = await sb
      .from('notification_settings')
      .select('user_id, due_minutes_before, quiet_start, quiet_end')
      .eq('push_enabled', true)
      .eq('due_reminder', true);
    if (uErr) throw uErr;
    if (!users?.length) return json({ ok: true, scanned: 0, sent: 0 });

    let totalSent = 0, totalSkipped = 0;
    const errors: string[] = [];

    for (const u of users) {
      try {
        // quiet時間チェック
        if (inQuietHours(now, u.quiet_start, u.quiet_end)) {
          totalSkipped++;
          continue;
        }

        // 当該ユーザーの今日 or 明日が期限の未完了タスクを取得
        // (dueAt は YYYY-MM-DD 形式の日付のみ)
        const { data: tasks } = await sb
          .from('tasks')
          .select('id, title, due_at, status')
          .eq('user_id', u.user_id)
          .in('due_at', [todayStr, tomorrowStr])
          .neq('status', 'completed')
          .neq('status', 'archived');
        if (!tasks?.length) continue;

        for (const t of tasks) {
          // 既送信チェック (今日のtaskIdに対して1回)
          const logKey = `due_${t.due_at}_${t.id}`;
          const { data: logHit } = await sb
            .from('notification_log')
            .select('id')
            .eq('user_id', u.user_id)
            .eq('kind', 'due')
            .eq('ref_id', logKey)
            .maybeSingle();
          if (logHit) continue;

          // 「今日が期限」のタスクのみ通知（明日のは事前準備フェッチ用、ここでは送らない）
          if (t.due_at !== todayStr) continue;

          const title = '⏰ タスクの期限';
          const body = `「${(t.title || '無題').slice(0, 50)}」が今日期限です`;
          const r = await sendPush(sb, u.user_id, {
            title, body,
            url: 'https://app.taskra.jp/?view=today',
            tag: 'due-' + t.id,
            taskId: t.id,
            kind: 'due',
          });
          if (r.sent > 0) {
            totalSent += r.sent;
            await sb.from('notification_log').insert({
              user_id: u.user_id, kind: 'due', ref_id: logKey,
            }).then(() => {}, () => {});
          }
        }
      } catch (innerErr: any) {
        errors.push(`user ${u.user_id}: ${innerErr?.message || innerErr}`);
      }
    }

    // 古いログ掃除（30日以上前を削除）
    try { await sb.rpc('purge_old_notification_log'); } catch (_) {}

    return json({ ok: true, scanned: users.length, sent: totalSent, skipped: totalSkipped, errors });
  } catch (e: any) {
    console.error('cron-task-reminders error', e);
    return json({ error: e?.message || 'internal error' }, 500);
  }
});
