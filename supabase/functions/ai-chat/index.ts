import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// プラン別の月次利用上限
const AI_LIMITS: Record<string, number> = {
  free:     20,
  standard: 100,
  premium:  500,
};

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ── 1. JWTからユーザー情報を取得 ──────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: '認証が必要です' }, 401);
    }

    // anon keyで初期化してユーザーJWTを検証
    const sbAnon = createClient(
      SUPABASE_URL,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await sbAnon.auth.getUser();
    if (authError || !user) {
      return json({ error: 'ログインが必要です' }, 401);
    }
    const email = user.email!;

    // ── 2. service_roleクライアント（DB操作用） ────────────
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── 3. プランを取得 ────────────────────────────────────
    const { data: planRow } = await sb
      .from('user_plans')
      .select('plan')
      .eq('email', email)
      .maybeSingle();
    const plan  = planRow?.plan ?? 'free';
    const limit = AI_LIMITS[plan] ?? AI_LIMITS.free;

    // ── 4. 今月の利用回数を確認（upsert） ────────────────
    const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

    const { data: usageRow, error: usageErr } = await sb
      .from('ai_usage')
      .select('count')
      .eq('email', email)
      .eq('month', month)
      .maybeSingle();

    if (usageErr) throw usageErr;

    const currentCount = usageRow?.count ?? 0;

    if (currentCount >= limit) {
      return json({
        error: 'limit_exceeded',
        message: `今月のAI利用回数（${limit}回）が上限に達しました。プランをアップグレードしてください。`,
        count: currentCount,
        limit,
        plan,
      }, 429);
    }

    // ── 5. リクエストボディを取得 ──────────────────────────
    const { system, messages, model, max_tokens } = await req.json();

    // ── 6. Anthropic APIを呼ぶ ────────────────────────────
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      model      ?? 'claude-sonnet-4-20250514',
        max_tokens: max_tokens ?? 1024,
        system,
        messages,
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error('Anthropic error:', errBody);
      return json({ error: 'AI APIエラーが発生しました' }, 500);
    }

    const aiData = await anthropicRes.json();

    // ── 7. 利用回数をインクリメント ───────────────────────
    if (usageRow) {
      await sb
        .from('ai_usage')
        .update({ count: currentCount + 1, updated_at: new Date().toISOString() })
        .eq('email', email)
        .eq('month', month);
    } else {
      await sb
        .from('ai_usage')
        .insert({ email, month, count: 1 });
    }

    // ── 8. レスポンスに残り回数を付加して返す ────────────
    return json({
      ...aiData,
      _usage: {
        count: currentCount + 1,
        limit,
        remaining: limit - (currentCount + 1),
        plan,
      },
    });

  } catch (e) {
    console.error('Edge function error:', e);
    return json({ error: '内部エラーが発生しました: ' + e.message }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
