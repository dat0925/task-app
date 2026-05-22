import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;
const LINE_ACCESS_TOKEN    = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function pushLine(lineUserId: string, text: string) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
  });
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');

  try {
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const today = jst.toISOString().slice(0, 10);
    console.log('LINE reminder:', today);

    const { data: lineUsers } = await sb
      .from('line_users')
      .select('line_user_id, taskra_user_id')
      .eq('linked', true);

    if (!lineUsers?.length) return new Response(JSON.stringify({ ok: true, sent: 0 }));

    let totalSent = 0;

    for (const lu of lineUsers) {
      const uid = lu.taskra_user_id;

      const [{ data: dueTasks }, { data: startTasks }] = await Promise.all([
        sb.from('tasks').select('title, priority')
          .eq('user_id', uid).eq('due_at', today)
          .neq('status', 'completed').neq('status', 'archived')
          .order('sort_order', { ascending: true }).limit(10),
        sb.from('tasks').select('title')
          .eq('user_id', uid).eq('start_at', today)
          .neq('status', 'completed').neq('status', 'archived')
          .order('sort_order', { ascending: true }).limit(5),
      ]);

      if (!dueTasks?.length && !startTasks?.length) continue;

      let msg = `📅 おはようございます！${today} の通知です。\n`;

      if (dueTasks?.length) {
        msg += `\n⏰ 今日が期限（${dueTasks.length}件）\n`;
        dueTasks.forEach((t, i) => {
          const pri = t.priority === 'high' ? ' 🔴' : t.priority === 'medium' ? ' 🟡' : '';
          msg += `${i + 1}. ${t.title}${pri}\n`;
        });
      }

      if (startTasks?.length) {
        msg += `\n🚀 今日から開始（${startTasks.length}件）\n`;
        startTasks.forEach((t, i) => { msg += `${i + 1}. ${t.title}\n`; });
      }

      msg += `\nhttps://app.taskra.jp`;

      if (await pushLine(lu.line_user_id, msg)) totalSent++;
    }

    return new Response(JSON.stringify({ ok: true, sent: totalSent }));
  } catch (e: any) {
    console.error('error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});
