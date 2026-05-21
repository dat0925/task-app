import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 90日以上経過した既読通知を削除
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    const { error, count } = await sb
      .from('notifications')
      .delete({ count: 'exact' })
      .eq('read', true)
      .lt('created_at', cutoff.toISOString());

    if (error) throw error;

    console.log(`cleanup-notifications: deleted ${count} records older than 90 days`);
    return new Response(JSON.stringify({ ok: true, deleted: count }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    console.error('cleanup-notifications error:', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
