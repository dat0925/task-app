import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createHmac } from 'https://deno.land/std@0.177.0/node/crypto.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;
const LINE_CHANNEL_SECRET  = Deno.env.get('LINE_CHANNEL_SECRET')!;
const LINE_ACCESS_TOKEN    = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!;
const ANTHROPIC_API_KEY    = Deno.env.get('ANTHROPIC_API_KEY') || '';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// LINE署名検証
function verifySignature(body: string, signature: string): boolean {
  const hmac = createHmac('sha256', LINE_CHANNEL_SECRET);
  hmac.update(body);
  const digest = hmac.digest('base64');
  return digest === signature;
}

// LINEにメッセージ返信
async function replyMessage(replyToken: string, messages: object[]) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

// LINEにプッシュメッセージ送信
async function pushMessage(lineUserId: string, messages: object[]) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: lineUserId, messages }),
  });
}

// ユーザー情報取得（LINE user_id → Taskra user）
async function getLinkedUser(lineUserId: string) {
  const { data } = await sb
    .from('line_users')
    .select('*')
    .eq('line_user_id', lineUserId)
    .single();
  return data;
}

// タスク一覧取得
async function getTodayTasks(taskraUserId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await sb
    .from('tasks')
    .select('id, title, due_at, status, priority')
    .eq('user_id', taskraUserId)
    .eq('due_at', today)
    .neq('status', 'completed')
    .order('sort_order', { ascending: true })
    .limit(10);
  return data || [];
}

// AIでメッセージを解釈してタスク情報を抽出
async function parseTaskWithAI(message: string, taskraUserId: string): Promise<{
  action: 'add_task' | 'list_today' | 'complete_task' | 'list_next' | 'unknown';
  title?: string;
  dueAt?: string;
  priority?: string;
  keyword?: string;
}> {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `今日の日付: ${today}、明日: ${tomorrow}
ユーザーのメッセージを解析してJSONのみ返してください。
actionは以下のいずれか:
- add_task: タスクを追加したい
- list_today: 今日のタスク一覧を見たい
- complete_task: タスクを完了にしたい
- list_next: 次にやることを見たい
- unknown: 不明

add_taskの場合はtitle(必須), dueAt(YYYY-MM-DD形式、なければnull), priority(high/medium/low/null)も返す
complete_taskの場合はkeyword(完了にするタスクのキーワード)も返す
JSONのみ、説明不要。`,
      messages: [{ role: 'user', content: message }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || '{}';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return { action: 'unknown' };
  }
}

// uid生成
function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// メインハンドラ
Deno.serve(async (req) => {
  if (req.method === 'GET') {
    return new Response('Taskra LINE Bot is running!', { status: 200 });
  }

  const body = await req.text();
  const signature = req.headers.get('x-line-signature') || '';

  // 署名検証
  if (!verifySignature(body, signature)) {
    console.error('Invalid signature');
    return new Response('Unauthorized', { status: 401 });
  }

  const payload = JSON.parse(body);
  const events = payload.events || [];

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const lineUserId = event.source.userId;
    const replyToken = event.replyToken;
    const userMessage = event.message.text.trim();

    // LINE連携ユーザー確認
    const linkedUser = await getLinkedUser(lineUserId);

    // 未連携の場合
    if (!linkedUser || !linkedUser.linked) {
      // 連携コードが送られてきた場合
      if (userMessage.startsWith('連携:')) {
        const code = userMessage.replace('連携:', '').trim();
        // コードからTaskraユーザーを検索
        const { data: linkData } = await sb
          .from('line_link_codes')
          .select('*')
          .eq('code', code)
          .eq('used', false)
          .gt('expires_at', new Date().toISOString())
          .single();

        if (linkData) {
          // 連携完了
          await sb.from('line_users').upsert({
            id: uid(),
            line_user_id: lineUserId,
            taskra_user_id: linkData.user_id,
            display_name: '',
            linked: true,
          });
          await sb.from('line_link_codes').update({ used: true }).eq('code', code);
          await replyMessage(replyToken, [{
            type: 'text',
            text: '✅ Taskraと連携しました！\n\n使い方：\n・「今日のタスクは？」→ 今日のタスク一覧\n・「〇〇をする」→ タスク追加\n・「〇〇完了」→ タスクを完了に',
          }]);
        } else {
          await replyMessage(replyToken, [{
            type: 'text',
            text: '❌ 連携コードが無効か期限切れです。\nTaskraの設定から新しいコードを発行してください。',
          }]);
        }
        continue;
      }

      // 未連携の場合の案内
      await replyMessage(replyToken, [{
        type: 'text',
        text: '👋 Taskra AIです！\n\nまずTaskraアカウントと連携してください。\n\napp.taskra.jp の設定→LINE連携 から連携コードを発行して、\n「連携:コード」と送ってください。',
      }]);
      continue;
    }

    const taskraUserId = linkedUser.taskra_user_id;

    // AIでメッセージを解釈
    const parsed = await parseTaskWithAI(userMessage, taskraUserId);
    console.log('parsed:', JSON.stringify(parsed));

    if (parsed.action === 'list_today') {
      // 今日のタスク一覧
      const tasks = await getTodayTasks(taskraUserId);
      if (!tasks.length) {
        await replyMessage(replyToken, [{ type: 'text', text: '📅 今日のタスクはありません。' }]);
      } else {
        const list = tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
        await replyMessage(replyToken, [{
          type: 'text',
          text: `📅 今日のタスク（${tasks.length}件）\n\n${list}`,
        }]);
      }

    } else if (parsed.action === 'add_task') {
      // タスク追加
      const newTask = {
        id: uid(),
        user_id: taskraUserId,
        title: parsed.title || userMessage,
        status: 'active',
        due_at: parsed.dueAt || null,
        priority: parsed.priority || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sort_order: Date.now(),
      };
      const { error } = await sb.from('tasks').insert(newTask);
      if (error) {
        console.error('insert error:', error);
        await replyMessage(replyToken, [{ type: 'text', text: '❌ タスクの追加に失敗しました。' }]);
      } else {
        const dueStr = parsed.dueAt ? `\n📅 期限: ${parsed.dueAt}` : '';
        await replyMessage(replyToken, [{
          type: 'text',
          text: `✅ タスクを追加しました！\n\n📝 ${parsed.title}${dueStr}\n\nhttps://app.taskra.jp で確認できます。`,
        }]);
      }

    } else if (parsed.action === 'complete_task') {
      // タスク完了
      const keyword = parsed.keyword || userMessage.replace(/完了|した|しました/g, '').trim();
      const { data: tasks } = await sb
        .from('tasks')
        .select('id, title')
        .eq('user_id', taskraUserId)
        .neq('status', 'completed')
        .ilike('title', `%${keyword}%`)
        .limit(1);

      if (!tasks?.length) {
        await replyMessage(replyToken, [{ type: 'text', text: `「${keyword}」に一致するタスクが見つかりませんでした。` }]);
      } else {
        await sb.from('tasks').update({
          status: 'completed',
          completed_at: new Date().toISOString(),
        }).eq('id', tasks[0].id);
        await replyMessage(replyToken, [{
          type: 'text',
          text: `✅ 完了しました！\n\n「${tasks[0].title}」`,
        }]);
      }

    } else {
      // 不明な場合はAIが自由回答
      await replyMessage(replyToken, [{
        type: 'text',
        text: '使い方：\n・「今日のタスクは？」→ 今日のタスク一覧\n・「〇〇をする」→ タスク追加\n・「〇〇完了」→ タスクを完了に\n・「次は？」→ 次のタスク確認',
      }]);
    }
  }

  return new Response('OK', { status: 200 });
});
