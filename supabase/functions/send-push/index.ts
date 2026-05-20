// Taskra - send-push edge function
// 指定ユーザーへ Web Push 通知を配信する共通関数
// 呼び出し方法:
//   POST /functions/v1/send-push
//   header: Authorization: Bearer <SB_SERVICE_ROLE_KEY>  (内部呼び出し用)
//        または Authorization: Bearer <user JWT>          (自分自身宛のテスト送信用)
//   body: { userId, title, body, url?, tag?, taskId?, kind?, requireInteraction? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;
const SB_ANON_KEY          = Deno.env.get('SB_ANON_KEY')!;
const VAPID_PUBLIC_KEY     = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY    = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT        = Deno.env.get('VAPID_SUBJECT') || 'mailto:support@taskra.jp';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

// 内部呼び出し（cron等）か、ユーザー自身のテスト送信かを判定
async function authenticate(req: Request): Promise<{ userId: string | null; isService: boolean }> {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return { userId: null, isService: false };

  // service_roleキーかチェック
  if (token === SUPABASE_SERVICE_KEY) {
    return { userId: null, isService: true };
  }

  // ユーザーJWT
  const sb = createClient(SUPABASE_URL, SB_ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + token } },
  });
  const { data: { user } } = await sb.auth.getUser();
  return { userId: user?.id || null, isService: false };
}

export async function sendPushToUser(
  sb: ReturnType<typeof createClient>,
  payload: {
    userId: string;
    title: string;
    body: string;
    url?: string;
    tag?: string;
    taskId?: string;
    kind?: string;
    requireInteraction?: boolean;
  }
) {
  const { userId } = payload;
  const { data: subs, error } = await sb
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  if (error) throw error;
  if (!subs?.length) return { sent: 0, failed: 0 };

  const notificationPayload = JSON.stringify({
    title: payload.title,
    body:  payload.body,
    url:   payload.url || 'https://app.taskra.jp',
    tag:   payload.tag,
    taskId: payload.taskId,
    kind: payload.kind,
    requireInteraction: !!payload.requireInteraction,
  });

  let sent = 0, failed = 0;
  const deadIds: string[] = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        notificationPayload
      );
      sent++;
      // last_used_atを更新（非同期で投げっぱなし）
      sb.from('push_subscriptions').update({ last_used_at: new Date().toISOString() })
        .eq('id', s.id).then(() => {});
    } catch (err: any) {
      failed++;
      const status = err?.statusCode;
      // 410 Gone / 404 Not Found → 購読は無効。削除。
      if (status === 410 || status === 404) {
        deadIds.push(s.id);
      }
      console.warn('push send failed', status, err?.message?.slice?.(0, 100));
    }
  }
  if (deadIds.length) {
    await sb.from('push_subscriptions').delete().in('id', deadIds);
  }
  return { sent, failed };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')    return json({ error: 'method not allowed' }, 405);

  try {
    const { userId: callerUid, isService } = await authenticate(req);
    if (!isService && !callerUid) return json({ error: 'unauthorized' }, 401);

    const body = await req.json();
    const targetUserId: string = body.userId || callerUid;
    if (!targetUserId) return json({ error: 'userId required' }, 400);

    // セキュリティ: 一般ユーザーは自分宛にしか送れない
    if (!isService && targetUserId !== callerUid) {
      return json({ error: 'cannot send to other users' }, 403);
    }

    if (!body.title) return json({ error: 'title required' }, 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const result = await sendPushToUser(sb, {
      userId: targetUserId,
      title: body.title,
      body: body.body || '',
      url: body.url,
      tag: body.tag,
      taskId: body.taskId,
      kind: body.kind,
      requireInteraction: body.requireInteraction,
    });

    return json({ ok: true, ...result });
  } catch (e: any) {
    console.error('send-push error', e);
    return json({ error: e?.message || 'internal error' }, 500);
  }
});
