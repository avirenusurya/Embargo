/**
 * Dodo Payments (Part 17.6). Checkout session + Standard-Webhooks signature verification.
 * Verify endpoint paths and event names against Dodo docs (Part 26 #5).
 */
import crypto from 'node:crypto';
import { config } from '../config.ts';
import { HttpError } from '../util.ts';

export async function createCheckout(opts: { workspaceId: string; email?: string | null; name?: string | null; returnUrl: string }) {
  if (!config.dodo.apiKey || !config.dodo.productTeam) throw new HttpError(503, 'billing_not_configured', 'Set DODO_API_KEY and DODO_PRODUCT_TEAM');
  const r = await fetch(`${config.dodo.baseUrl}/checkouts`, {
    method: 'POST', headers: { authorization: `Bearer ${config.dodo.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      product_cart: [{ product_id: config.dodo.productTeam, quantity: 1 }],
      customer: opts.email ? { email: opts.email, name: opts.name ?? opts.email } : undefined,
      return_url: opts.returnUrl, metadata: { workspace_id: opts.workspaceId },
    }),
  });
  if (!r.ok) throw new HttpError(502, 'billing_error', `Dodo checkout failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return { checkout_url: j.checkout_url ?? j.url ?? j.payment_link, session_id: j.session_id ?? j.id };
}

/** Standard Webhooks: signature = base64(HMAC_SHA256(secret, `${id}.${timestamp}.${body}`)), header "v1,<sig> ..." */
export function verifyDodoWebhook(raw: Buffer, headers: Record<string, any>) {
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'], sigs = String(headers['webhook-signature'] ?? '');
  if (!config.dodo.webhookSecret || !id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const secret = config.dodo.webhookSecret.startsWith('whsec_') ? Buffer.from(config.dodo.webhookSecret.slice(6), 'base64') : Buffer.from(config.dodo.webhookSecret);
  const exp = crypto.createHmac('sha256', secret).update(`${id}.${ts}.${raw.toString('utf8')}`).digest('base64');
  return sigs.split(' ').some((s) => { const v = s.split(',')[1] ?? ''; return v.length === exp.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(exp)); });
}
