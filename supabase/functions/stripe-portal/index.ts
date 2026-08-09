import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;

// CORS: ワイルドカード(*)ではなく許可オリジンのみに限定（多層防御）。
// このFunctionはJWT必須だが、ブラウザからの誤用を減らすためオリジンも絞る。
const ALLOWED_ORIGINS = ['https://app.taskra.jp'];

const corsHeadersFor = (req: Request) => {
  const origin = req.headers.get('Origin') ?? '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  };
};

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // 1. JWT検証
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: '認証が必要です' }, 401);

    const sbAnon = createClient(
      SUPABASE_URL,
      Deno.env.get('SB_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await sbAnon.auth.getUser();
    if (authError || !user) return json({ error: 'ログインが必要です' }, 401);

    // 2. stripe_customer_id を取得
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: planRow } = await sb
      .from('user_plans')
      .select('stripe_customer_id')
      .eq('email', user.email)
      .maybeSingle();

    let customerId = planRow?.stripe_customer_id;

    // CustomerIDがない or 空の場合はStripeで新規作成してDBに保存（自動復旧）
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email!,
        metadata: { supabase_uid: user.id },
      });
      customerId = customer.id;

      // DBに保存（次回以降は自動復旧）
      await sb
        .from('user_plans')
        .update({ stripe_customer_id: customerId })
        .eq('email', user.email);

      console.info(`[stripe-portal] Created new Stripe customer: ${customerId} for ${user.email}`);
    }

    // 3. return_url を取得（リクエストボディから）
    const body = await req.json().catch(() => ({}));
    const returnUrl = body.return_url || 'https://app.taskra.jp';

    // 4. カスタマーポータルセッション作成
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: 'エラーが発生しました' }, 500);
  }
});
