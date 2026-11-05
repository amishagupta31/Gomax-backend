import type { Config } from '../config.js';

export interface WhatsApp {
  /** Sends an approved template; `vars` are filled into {{1}}, {{2}}… in PARAMS order. */
  send(toMobile: string, template: string, vars: Record<string, string>): Promise<void>;
}

/** Order of {{1}}, {{2}}… per template — must match Meta Business Manager. */
export const PARAMS: Record<string, string[]> = {
  welcome: ['name', 'mobile'],
  daily_summary: ['count', 'points', 'pointsBalance', 'runsBalance', 'left'],
  scratch_card: ['name'],
  withdrawal_approved: ['amount'],
  withdrawal_paid: ['amount', 'upi', 'utr', 'date'],
  withdrawal_rejected: ['amount', 'reason'],
  withdrawal_failed: ['amount', 'upi'],
  gift_packed: ['gift'],
  gift_shipped: ['gift', 'courier', 'awb'],
  gift_delivered: ['gift', 'date'],
  rank_up: ['name', 'rank', 'benefits', 'next'],
  challenge_won: ['challenge', 'runs'],
  kyc_reminder: ['points'],
  password_reset: ['link'],
  friend_joined: ['friend', 'code', 'runs'],
  streak_missed: ['name'],
  streak_photo_rejected: ['reason'],
};

export function metaWhatsApp(c: Config): WhatsApp {
  if (!c.WA_TOKEN || !c.WA_PHONE_NUMBER_ID) throw new Error('WA_TOKEN and WA_PHONE_NUMBER_ID are required for WHATSAPP_DRIVER=meta');
  return {
    async send(to, template, vars) {
      const params = (PARAMS[template] ?? []).map((k) => ({ type: 'text', text: vars[k] ?? '' }));
      const res = await fetch(`https://graph.facebook.com/v21.0/${c.WA_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: `91${to}`,
          type: 'template',
          template: {
            name: template,
            language: { code: vars.lang ?? 'hi' },
            components: params.length ? [{ type: 'body', parameters: params }] : [],
          },
        }),
      });
      if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 300)}`);
    },
  };
}

export type SentMessage = { to: string; template: string; vars: Record<string, string> };

/** Dev / tests: records messages instead of sending them. */
export function logWhatsApp(log: (msg: string) => void = () => undefined): WhatsApp & { sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    sent,
    async send(to, template, vars) {
      sent.push({ to, template, vars });
      log(`[whatsapp] to ${to} ${template} ${JSON.stringify(vars)}`);
    },
  };
}

export const createWhatsApp = (c: Config, log?: (m: string) => void): WhatsApp =>
  c.WHATSAPP_DRIVER === 'meta' ? metaWhatsApp(c) : logWhatsApp(log);
