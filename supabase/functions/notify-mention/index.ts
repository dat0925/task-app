import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'https://esm.sh/web-push@3.6.7';

const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY     = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE_KEY    = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT        = Deno.env.get('VAPID_SUBJECT') || 'mailto:support@taskra.jp';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ── 1. JWT認証 ────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: '認証が必要です' }, 401);

    const sbAnon = createClient(
      SUPABASE_URL,
      Deno.env.get('SB_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await sbAnon.auth.getUser();
    if (authError || !user) return json({ error: 'ログインが必要です' }, 401);

    // ── 2. リクエストボディ ──────────────────────────────────
    const { taskId, taskTitle, commentBody, mentionedUserIds } = await req.json();
    if (!Array.isArray(mentionedUserIds) || !mentionedUserIds.length) {
      return json({ ok: true, sent: 0 });
    }

    // ── 3. service_role で対象ユーザーのメールを取得 ─────────
    //    RLS をバイパスして workspace_members から email を引く
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: members, error: membersError } = await sb
      .from('workspace_members')
      .select('user_id, user_email, user_name')
      .in('user_id', mentionedUserIds);

    if (membersError) throw membersError;
    if (!members?.length) return json({ ok: true, sent: 0 });

    // ── 4. Resend でメール送信 ────────────────────────────────
    const senderName = user.user_metadata?.full_name || user.email || 'メンバー';
    const appUrl     = 'https://app.taskra.jp';
    let sent = 0;

    for (const member of members) {
      // メールアドレスなし はスキップ（自己メンションは送信する）
      if (!member.user_email) continue;

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from:    'Taskra <onboarding@resend.dev>',
          to:      [member.user_email],
          subject: `${senderName} さんがコメントであなたをメンションしました`,
          html:    buildHtml(senderName, taskTitle || taskId, commentBody, appUrl),
        }),
      });

      if (res.ok) {
        sent++;
      } else {
        const errText = await res.text();
        console.error('Resend error for', member.user_email, ':', errText);
      }
    }

    // ── 5. Web Push 通知も配信（設定でONにしている人のみ） ────
    let pushSent = 0;
    if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      try {
        const { data: settings } = await sb
          .from('notification_settings')
          .select('user_id')
          .in('user_id', mentionedUserIds)
          .eq('push_enabled', true)
          .eq('mention_notify', true);
        const enabledIds = (settings || []).map(s => s.user_id);
        if (enabledIds.length) {
          const { data: subs } = await sb
            .from('push_subscriptions')
            .select('id, user_id, endpoint, p256dh, auth')
            .in('user_id', enabledIds);
          const dead: string[] = [];
          const pushPayload = JSON.stringify({
            title: `💬 ${senderName} さんからメンション`,
            body: (commentBody || '').slice(0, 120),
            url: appUrl,
            tag: 'mention-' + taskId,
            taskId,
            kind: 'mention',
          });
          for (const s of (subs || [])) {
            try {
              await webpush.sendNotification(
                { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                pushPayload
              );
              pushSent++;
            } catch (err: any) {
              const code = err?.statusCode;
              if (code === 410 || code === 404) dead.push(s.id);
              console.warn('push fail', code, err?.message?.slice?.(0, 80));
            }
          }
          if (dead.length) {
            await sb.from('push_subscriptions').delete().in('id', dead);
          }
        }
      } catch (pushErr) {
        console.error('push notification error (non-fatal):', pushErr);
      }
    }

    return json({ ok: true, sent, pushSent });

  } catch (e) {
    console.error('notify-mention error:', e);
    return json({ error: '内部エラー: ' + (e as Error).message }, 500);
  }
});

// ── HTMLメール本文 ──────────────────────────────────────────────
function buildHtml(
  senderName:  string,
  taskTitle:   string,
  commentBody: string,
  appUrl:      string
): string {
  const escaped = commentBody
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <div style="background:#6366f1;padding:24px 28px">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">📣 メンション通知</h1>
    </div>
    <div style="padding:24px 28px">
      <p style="margin:0 0 16px;color:#333;font-size:15px;line-height:1.6">
        <b>${senderName}</b> さんがタスク「<b>${taskTitle}</b>」のコメントであなたをメンションしました。
      </p>
      <div style="background:#f8f7ff;border-left:4px solid #6366f1;padding:14px 16px;border-radius:0 8px 8px 0;color:#333;font-size:14px;line-height:1.7">${escaped}</div>
      <div style="margin-top:24px;text-align:center">
        <a href="${appUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Taskraで確認する →</a>
      </div>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #eee;color:#aaa;font-size:12px;text-align:center">
      このメールは <a href="${appUrl}" style="color:#6366f1;text-decoration:none">Taskra</a> からの自動通知です。
    </div>
  </div>
</body>
</html>`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
