import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.7.0";

function serviceKey(): string {
  // Legacy service_role JWT is the most compatible with supabase-js Authorization.
  // Prefer it so admin reads are not accidentally made with a publishable/secret-key mismatch.
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      const candidate = parsed.service_role || parsed.default || Object.values(parsed)[0] || "";
      if (candidate && !candidate.startsWith("sb_publishable_") && candidate !== (Deno.env.get("SUPABASE_ANON_KEY") || "")) {
        return candidate;
      }
    } catch {
      /* fall through */
    }
  }
  return "";
}

function orderIdFrom(session: Stripe.Checkout.Session): string | null {
  const fromMeta = session.metadata?.order_id;
  if (fromMeta) return fromMeta;
  return session.client_reference_id || null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const sbUrl = Deno.env.get("SUPABASE_URL");
  const sbKey = serviceKey();
  if (!stripeKey || !webhookSecret || !sbUrl || !sbKey) {
    return new Response("Not configured", { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  const raw = await req.text();
  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, webhookSecret);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  const supabase = createClient(sbUrl, sbKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = orderIdFrom(session);
      if (!orderId) return new Response("ok", { status: 200 });
      // Cards usually arrive as paid; ignore unpaid completed (async methods wait for a later event)
      if (session.payment_status && session.payment_status !== "paid") {
        return new Response("ok", { status: 200 });
      }
      const patch: Record<string, string> = { payment_status: "paid" };
      if (session.id) patch.payment_ref = session.id;
      const { error } = await supabase.from("orders").update(patch).eq("id", orderId).neq("payment_status", "paid");
      if (error) return new Response("Update failed", { status: 500 });
    } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = orderIdFrom(session);
      if (!orderId) return new Response("ok", { status: 200 });
      const { error } = await supabase
        .from("orders")
        .update({ payment_status: "failed" })
        .eq("id", orderId)
        .eq("payment_status", "unpaid");
      if (error) return new Response("Update failed", { status: 500 });
    }
  } catch {
    return new Response("Handler error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
