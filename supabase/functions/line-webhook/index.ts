import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;
const LINE_CHANNEL_SECRET  = Deno.env.get('LINE_CHANNEL_SECRET')!;
const LINE_ACCESS_TOKEN    = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!;
const ANTHROPIC_API_KEY    = Deno.env.get('ANTHROPIC_API_KEY') || '';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function verifySignature(body: string, signature: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(LINE_CHANNEL_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    return btoa(String.fromCharCode(...new Uint8Array(sig))) === signature;
  } catch { return false; }
}

async function replyMessage(replyToken: string, messages: object[]) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  });
}

async function getLinkedUser(lineUserId: string) {
  const { data } = await sb.from('line_users').select('*').eq('line_user_id', lineUserId).single();
  return data;
}

async function getTodayTasks(uid: string) {
  const today = getJstDate(0);
  const { data } = await sb.from('tasks').select('id, title, due_at, priority')
    .eq('user_id', uid).eq('due_at', today)
    .neq('status', 'completed').order('sort_order', { ascending: true }).limit(10);
  return data || [];
}

// JSTで今日から+n日の日付を返す
function getJstDate(plusDays: number): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + plusDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

async function parseTaskWithAI(message: string) {
  const today = getJstDate(0);
  const tomorrow = getJstDate(1);
  const in3days = getJstDate(3);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `今日:${today} 明日:${tomorrow} 3日後:${in3days}
メッセージを解析しJSONのみ返す。
action: add_task/list_today/complete_task/list_next/unknown
add_taskならtitle(必須),dueAt(YYYY-MM-DD、明示的に指定された場合のみ、なければnull),priority(high/medium/low/null)
complete_taskならkeyword
JSONのみ、余分なテキスト不要。`,
      messages: [{ role: 'user', content: message }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || '{}';
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return { action: 'unknown' }; }
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

Deno.serve(async (req) => {
  if (req.method === 'GET') return new Response('OK', { status: 200 });

  const body = await req.text();
  const signature = req.headers.get('x-line-signature') || '';

  if (!body || body === '{}') return new Response('OK', { status: 200 });

  const valid = await verifySignature(body, signature);
  if (!valid) {
    const payload = JSON.parse(body);
    if (!payload.events?.length) return new Response('OK', { status: 200 });
    return new Response('Unauthorized', { status: 401 });
  }

  const { events = [] } = JSON.parse(body);

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const lineUserId = event.source.userId;
    const replyToken = event.replyToken;
    const userMessage = event.message.text.trim();
    const linkedUser = await getLinkedUser(lineUserId);

    // 未連携
    if (!linkedUser?.linked) {
      if (userMessage.startsWith('連携:')) {
        const code = userMessage.replace('連携:', '').trim();
        const { data: linkData } = await sb.from('line_link_codes').select('*')
          .eq('code', code).eq('used', false)
          .gt('expires_at', new Date().toISOString()).single();

        if (linkData) {
          await sb.from('line_users').upsert({
            id: uid(), line_user_id: lineUserId,
            taskra_user_id: linkData.user_id, display_name: '', linked: true,
          });
          await sb.from('line_link_codes').update({ used: true }).eq('code', code);
          await replyMessage(replyToken, [{
            type: 'text',
            text: '✅ Taskraと連携しました！\n\n使い方：\n・「今日のタスクは？」→ 今日のタスク一覧\n・「〇〇をする」→ タスク追加\n・「〇〇完了」→ タスクを完了に\n・「次は？」→ 各PJの次のアクション',
          }]);
        } else {
          await replyMessage(replyToken, [{ type: 'text', text: '❌ 連携コードが無効か期限切れです。\nTaskraの設定から新しいコードを発行してください。' }]);
        }
        continue;
      }
      await replyMessage(replyToken, [{
        type: 'text',
        text: '👋 Taskra AIです！\n\nTaskraアカウントと連携が必要です。\nhttps://app.taskra.jp の設定→LINE連携 から連携コードを発行して、\n「連携:コード」と送ってください。',
      }]);
      continue;
    }

    const taskraUserId = linkedUser.taskra_user_id;
    const parsed = await parseTaskWithAI(userMessage);
    console.log('action:', parsed.action);

    if (parsed.action === 'list_today') {
      const tasks = await getTodayTasks(taskraUserId);
      if (!tasks.length) {
        await replyMessage(replyToken, [{ type: 'text', text: '📅 今日のタスクはありません。' }]);
      } else {
        const list = tasks.map((t: any, i: number) => `${i + 1}. ${t.title}`).join('\n');
        await replyMessage(replyToken, [{ type: 'text', text: `📅 今日のタスク（${tasks.length}件）\n\n${list}` }]);
      }

    } else if (parsed.action === 'add_task') {
      // Taskraのデフォルト値と同じ: status=inbox, startAt=今日, dueAt=3日後（指定なしの場合）
      const today = getJstDate(0);
      const in3days = getJstDate(3);
      const newTask = {
        id: uid(),
        user_id: taskraUserId,
        title: parsed.title || userMessage,
        status: 'inbox',                          // プロジェクト未設定→inbox
        start_at: today,                          // 開始日=今日
        due_at: parsed.dueAt || in3days,          // 期限=指定があればそちら、なければ3日後
        priority: parsed.priority || null,
        project_id: null,                         // Inboxに入るようproject_id=null
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sort_order: Date.now(),
      };
      const { error } = await sb.from('tasks').insert(newTask);
      if (error) {
        console.error('insert error:', error);
        await replyMessage(replyToken, [{ type: 'text', text: '❌ タスクの追加に失敗しました。' }]);
      } else {
        const dueStr = `\n📅 期限: ${newTask.due_at}`;
        await replyMessage(replyToken, [{
          type: 'text',
          text: `✅ タスクを追加しました！\n\n📝 ${newTask.title}${dueStr}\n\nhttps://app.taskra.jp/?openExternalBrowser=1#task/${newTask.id} で確認できます。`,
        }]);
      }

    } else if (parsed.action === 'complete_task') {
      const keyword = parsed.keyword || userMessage.replace(/完了|した|しました/g, '').trim();
      const { data: tasks } = await sb.from('tasks').select('id, title')
        .eq('user_id', taskraUserId).neq('status', 'completed')
        .ilike('title', `%${keyword}%`).limit(1);

      if (!tasks?.length) {
        await replyMessage(replyToken, [{ type: 'text', text: `「${keyword}」に一致するタスクが見つかりませんでした。` }]);
      } else {
        await sb.from('tasks').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', tasks[0].id);
        await replyMessage(replyToken, [{ type: 'text', text: `✅ 完了しました！\n\n「${tasks[0].title}」` }]);
      }

    } else if (parsed.action === 'list_next') {
      const { data: projects } = await sb.from('projects').select('id, name')
        .eq('user_id', taskraUserId).neq('status', 'archived').limit(20);

      if (!projects?.length) {
        await replyMessage(replyToken, [{ type: 'text', text: 'プロジェクトがありません。' }]);
      } else {
        const nextTasks = [];
        for (const proj of projects) {
          const { data: task } = await sb.from('tasks').select('title')
            .eq('user_id', taskraUserId).eq('project_id', proj.id)
            .neq('status', 'completed').order('sort_order', { ascending: true }).limit(1).single();
          if (task) nextTasks.push(`📁 ${proj.name}\n   → ${task.title}`);
        }
        if (!nextTasks.length) {
          await replyMessage(replyToken, [{ type: 'text', text: '✅ 全プロジェクトのタスクが完了しています！' }]);
        } else {
          await replyMessage(replyToken, [{
            type: 'text',
            text: `📋 各プロジェクトの次のアクション\n\n${nextTasks.slice(0, 8).join('\n\n')}`,
          }]);
        }
      }

    } else {
      await replyMessage(replyToken, [{
        type: 'text',
        text: '使い方：\n・「今日のタスクは？」→ 今日のタスク一覧\n・「〇〇をする」→ タスク追加\n・「〇〇完了」→ タスクを完了に\n・「次は？」→ 各PJの次のアクション',
      }]);
    }
  }

  return new Response('OK', { status: 200 });
});
