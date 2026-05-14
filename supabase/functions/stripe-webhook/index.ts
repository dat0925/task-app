import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

const WEBHOOK_SECRET    = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;

// Stripe Price ID → プラン名のマッピング
const PRICE_PLAN: Record<string, string> = {
  [Deno.env.get('STRIPE_STANDARD_PRICE_ID') ?? '']: 'standard',
  [Deno.env.get('STRIPE_PREMIUM_PRICE_ID')  ?? '']: 'premium',
};

Deno.serve(async (req) => {
  const body = await req.text();
  const sig  = req.headers.get('stripe-signature') ?? '';

  // 署名検証
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, WEBHOOK_SECRET);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Webhook signature error:', msg);
    return new Response(`Webhook error: ${msg}`, { status: 400 });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    switch (event.type) {

      // ── 決済完了：プランを standard / premium に更新 ──────────
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId  = session.customer as string;
        const userId      = session.client_reference_id ?? ''; // Supabase user UUID

        // メールアドレスの取得（Stripe → なければ auth.users から）
        let email: string | undefined = session.customer_details?.email ?? session.customer_email ?? undefined;
        if (!email && userId) {
          const { data } = await sb.auth.admin.getUserById(userId);
          email = data?.user?.email;
        }
        if (!email) { console.error('email not found', session.id); break; }

        // 購入プランの特定
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
        const priceId   = lineItems.data[0]?.price?.id ?? '';
        const plan      = PRICE_PLAN[priceId] ?? 'standard';

        await sb.from('user_plans').upsert(
          { email, plan, stripe_customer_id: customerId, updated_at: new Date().toISOString() },
          { onConflict: 'email' }
        );
        console.log(`Plan updated: ${email} → ${plan}`);
        break;
      }

      // ── 新規サブスク作成：stripe_customer_id を保存 ──────────
      case 'customer.subscription.created': {
        const sub        = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        if (sub.status !== 'active') break;

        const priceId = sub.items.data[0]?.price?.id ?? '';
        const plan    = PRICE_PLAN[priceId] ?? 'standard';

        // Stripe顧客からメールを取得
        const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
        const email    = customer.email;
        if (!email) { console.error('email not found for customer', customerId); break; }

        await sb.from('user_plans').upsert(
          { email, plan, stripe_customer_id: customerId, updated_at: new Date().toISOString() },
          { onConflict: 'email' }
        );
        console.log(`Subscription created: ${email} → ${plan}, customer: ${customerId}`);
        break;
      }

      // ── サブスク解約：フリープランに戻す ─────────────────────
      case 'customer.subscription.deleted': {
        const sub        = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        await sb.from('user_plans')
          .update({ plan: 'free', updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', customerId);
        console.log(`Downgraded to free: customer ${customerId}`);
        break;
      }

      // ── プラン変更（アップグレード / ダウングレード） ─────────
      case 'customer.subscription.updated': {
        const sub        = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        if (sub.status !== 'active') break;

        const priceId = sub.items.data[0]?.price?.id ?? '';
        const plan    = PRICE_PLAN[priceId];
        if (!plan) break;

        await sb.from('user_plans')
          .update({ plan, updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', customerId);
        console.log(`Plan changed: customer ${customerId} → ${plan}`);
        break;
      }

      // ── 支払い失敗（任意：フリーに落とす場合はコメントを外す） ─
      // case 'invoice.payment_failed': { break; }
    }
  } catch (e: unknown) {
    console.error('Handler error:', e instanceof Error ? e.message : e);
    return new Response('Internal error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
