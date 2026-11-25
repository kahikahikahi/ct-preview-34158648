import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.7.0";

const ALLOWED_BASES = [
  "https://kahikahikahi.github.io/ct-preview-34158648/",
  "https://www.cafeturquoise.nz/",
  "https://cafeturquoise.nz/",
  "http://127.0.0.1:8766/",
  "http://localhost:8766/",
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function serviceKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed.default || parsed.service_role || Object.values(parsed)[0] || "";
    } catch {
      /* fall through */
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

function allowedReturnBase(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return ALLOWED_BASES[0];
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return ALLOWED_BASES[0];
  }
  if (url.username || url.password) return ALLOWED_BASES[0];
  const normalized = url.href.endsWith("/") ? url.href : url.href + "/";
  if (ALLOWED_BASES.some((b) => normalized === b || normalized.startsWith(b))) return normalized;
  return ALLOWED_BASES[0];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { message: "Method not allowed." });

  try {
    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object") return json(400, { message: "Invalid request." });

    const requestId = typeof payload.request_id === "string" ? payload.request_id.trim() : "";
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    const ref = typeof payload.ref === "string" ? payload.ref.trim() : "";
    if (!requestId || (!id && !ref)) {
      return json(400, { message: "Missing order details." });
    }

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const sbUrl = Deno.env.get("SUPABASE_URL");
    const sbKey = serviceKey();
    if (!stripeKey || !sbUrl || !sbKey) {
      return json(503, { message: "Online payments are not configured yet. Please pay at the counter, or call us on 06 757 8921." });
    }

    const supabase = createClient(sbUrl, sbKey, { auth: { persistSession: false, autoRefreshToken: false } });
    let q = supabase.from("orders").select("id, ref, request_id, email, payment_method, payment_status, payment_ref, status, total_cents, order_items(id, name, qty, unit_cents, line_cents)").eq("request_id", requestId);
    q = id ? q.eq("id", id) : q.eq("ref", ref);
    const { data: order, error } = await q.maybeSingle();
    if (error || !order) return json(404, { message: "Order not found." });
    if (order.payment_method !== "online") return json(400, { message: "This order is not an online payment." });
    if (order.payment_status === "paid") return json(409, { message: "This order is already paid." });
    if (order.status === "cancelled") return json(400, { message: "This order was cancelled." });

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });

    if (typeof order.payment_ref === "string" && order.payment_ref.startsWith("cs_")) {
      try {
        const existing = await stripe.checkout.sessions.retrieve(order.payment_ref);
        if (existing.status === "open" && existing.url) {
          return json(200, { url: existing.url, id: existing.id });
        }
      } catch {
        /* create a new session */
      }
    }

    const items = Array.isArray(order.order_items) ? order.order_items : [];
    if (!items.length) return json(400, { message: "This order has no items." });
    const sum = items.reduce((s: number, it: { line_cents: number }) => s + Number(it.line_cents || 0), 0);
    const line_items = (sum === Number(order.total_cents)
      ? items.map((it: { name: string; qty: number; unit_cents: number }) => ({
          quantity: Number(it.qty),
          price_data: {
            currency: "nzd",
            unit_amount: Number(it.unit_cents),
            product_data: { name: String(it.name || "Item") },
          },
        }))
      : [{
          quantity: 1,
          price_data: {
            currency: "nzd",
            unit_amount: Number(order.total_cents),
            product_data: { name: `Café Turquoise order ${order.ref}` },
          },
        }]
    );

    const base = allowedReturnBase(payload.return_base);
    const rid = encodeURIComponent(requestId);
    const oref = encodeURIComponent(order.ref);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: `${base}order/?ref=${oref}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}order/?ref=${oref}&cancelled=1&rid=${rid}`,
      customer_email: order.email || undefined,
      client_reference_id: order.id,
      metadata: { order_id: order.id, order_ref: order.ref },
      expires_at: Math.floor(Date.now() / 1000) + 45 * 60,
    });

    const { error: upErr } = await supabase.from("orders").update({ payment_ref: session.id }).eq("id", order.id);
    if (upErr || !session.url) {
      return json(500, { message: "Sorry, that didn't go through. Please try again, or call us on 06 757 8921." });
    }

    return json(200, { url: session.url, id: session.id });
  } catch {
    return json(500, { message: "Sorry, that didn't go through. Please try again, or call us on 06 757 8921." });
  }
});
