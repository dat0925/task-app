// Taskra - cron-repeat-start edge function
// 繰り返しタスクの開始通知（今日の朝、繰り返しタスクが当日アクティブになるタイミング）

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
  if (!subs?.length) return 0;
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
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
    if (auth !== SUPABASE_SERVICE_KEY) {
      const cs = req.headers.get('X-Cron-Secret') || '';
      if (!CRON_SECRET || cs !== CRON_SECRET) return json({ error: 'unauthorized' }, 401);
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // repeat_start ONのユーザーを取得
    const { data: users } = await sb
      .from('notification_settings')
      .select('user_id')
      .eq('push_enabled', true)
      .eq('repeat_start', true);
    if (!users?.length) return json({ ok: true, scanned: 0, sent: 0 });

    let totalSent = 0;

    for (const u of users) {
      // 今日 startAt or dueAt の repeat_rule 付きアクティブタスク
      const { data: tasks } = await sb
        .from('tasks')
        .select('id, title, start_at, due_at, repeat_rule, status')
        .eq('user_id', u.user_id)
        .neq('status', 'completed')
        .neq('status', 'archived')
        .not('repeat_rule', 'is', null);
      if (!tasks?.length) continue;

      const todayTasks = tasks.filter(t =>
        t.start_at === todayStr || t.due_at === todayStr
      );

      for (const t of todayTasks) {
        const logKey = `repeat_${todayStr}_${t.id}`;
        const { data: logHit } = await sb
          .from('notification_log')
          .select('id')
          .eq('user_id', u.user_id)
          .eq('kind', 'repeat_start')
          .eq('ref_id', logKey)
          .maybeSingle();
        if (logHit) continue;

        const sent = await sendPush(sb, u.user_id, {
          title: '🔁 今日の繰り返しタスク',
          body: `「${(t.title || '無題').slice(0, 50)}」を今日実施しましょう`,
          url: 'https://app.taskra.jp/?view=today',
          tag: 'repeat-' + t.id,
          taskId: t.id,
          kind: 'repeat_start',
        });
        if (sent > 0) {
          totalSent += sent;
          await sb.from('notification_log').insert({
            user_id: u.user_id, kind: 'repeat_start', ref_id: logKey,
          }).then(() => {}, () => {});
        }
      }
    }

    return json({ ok: true, scanned: users.length, sent: totalSent });
  } catch (e: any) {
    console.error('cron-repeat-start error', e);
    return json({ error: e?.message || 'internal error' }, 500);
  }
});
