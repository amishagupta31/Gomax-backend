import { createHmac } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { safeEqual } from '../lib/crypto.js';
import { forbidden } from '../lib/errors.js';
import { startWhatsAppReset } from './auth.js';
import { verifyRazorpaySignature, type Payout } from '../lib/razorpay.js';
import { applyPayoutUpdate } from '../services/payouts.js';

// Meta WhatsApp Cloud API webhook.
// A1-11/12: the user sends "RESET 98765 43210" from that same number; we reply
// with a one-time reset link (C4-11). Messages from any other number are ignored.
type WaInbound = {
  entry?: { changes?: { value?: { messages?: { from?: string; type?: string; text?: { body?: string } }[] } }[] }[];
};

const routes: FastifyPluginAsync = async (app) => {
  const { db, config, now } = app.deps;

  app.get('/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && config.WA_VERIFY_TOKEN && q['hub.verify_token'] === config.WA_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge']);
    }
    throw forbidden();
  });

  app.post('/whatsapp', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const secret = config.WA_APP_SECRET;
    if (secret) {
      const sig = String(req.headers['x-hub-signature-256'] ?? '');
      const want = `sha256=${createHmac('sha256', secret).update(req.rawBody ?? '').digest('hex')}`;
      if (!safeEqual(sig, want)) throw forbidden();
    } else if (config.NODE_ENV === 'production') {
      throw forbidden();
    }
    const body = req.body as WaInbound;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          const text = m.type === 'text' ? (m.text?.body ?? '') : '';
          const match = text.toUpperCase().match(/RESET\s*([\d\s]{10,14})/);
          const from = (m.from ?? '').replace(/\D/g, '').slice(-10);
          if (!match) continue;
          const asked = match[1].replace(/\D/g, '').slice(-10);
          // Only the owner of the number can reset it.
          if (asked === from) await startWhatsAppReset(db, config.APP_LINK_BASE, from, now());
        }
      }
    }
    return { ok: true }; // Meta retries anything that isn't 200
  });

  // RazorpayX payout events (payout.processed / failed / rejected / reversed / queued / …).
  // Configure in RazorpayX → Settings → Webhooks with RAZORPAY_WEBHOOK_SECRET.
  app.post('/razorpay', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    const secret = config.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !verifyRazorpaySignature(req.rawBody ?? '', req.headers['x-razorpay-signature'] as string | undefined, secret)) throw forbidden();
    const body = req.body as { event?: string; payload?: { payout?: { entity?: Payout } } };
    const payout = body.payload?.payout?.entity;
    if (body.event?.startsWith('payout.') && payout?.id) await applyPayoutUpdate(db, payout, now());
    return { ok: true }; // Razorpay retries anything that isn't 2xx
  });
};

export default routes;
