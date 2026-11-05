// RazorpayX — payouts to applicators' UPI IDs, and UPI name checks.
// Docs: https://razorpay.com/docs/api/x/  (Contacts, Fund Accounts,
// Fund Account Validation, Payouts, Webhooks). All amounts are in paise.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type RazorpayConfig = {
  keyId: string;
  keySecret: string;
  /** RazorpayX business account number money is paid from. */
  accountNumber: string;
  baseUrl?: string;
};

export type PayoutStatus = 'queued' | 'pending' | 'rejected' | 'processing' | 'processed' | 'cancelled' | 'reversed' | 'failed';

export type Payout = {
  id: string;
  status: PayoutStatus;
  amount: number;
  utr: string | null;
  reference_id: string | null;
  failure_reason?: string | null;
  status_details?: { description?: string | null; reason?: string | null } | null;
};

export class RazorpayError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
  /** 4xx (except 429) won't succeed on retry: bad UPI, bad request, auth. */
  get permanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

type Fetch = typeof fetch;

export function razorpayClient(cfg: RazorpayConfig, fetchImpl: Fetch = fetch) {
  const base = cfg.baseUrl ?? 'https://api.razorpay.com/v1';
  const auth = `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`;

  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new RazorpayError(0, 'network', `Razorpay not reachable: ${(e as Error).message}`);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = json?.error ?? {};
      throw new RazorpayError(res.status, err.code ?? `http_${res.status}`, err.description ?? `Razorpay HTTP ${res.status}`);
    }
    return json as T;
  }

  return {
    accountNumber: cfg.accountNumber,

    createContact: (c: { name: string; mobile: string; referenceId: string }) =>
      call<{ id: string }>('POST', '/contacts', {
        name: c.name.slice(0, 50),
        contact: c.mobile,
        type: 'customer',
        reference_id: c.referenceId.slice(0, 40),
      }),

    createVpaFundAccount: (contactId: string, vpa: string) =>
      call<{ id: string }>('POST', '/fund_accounts', { contact_id: contactId, account_type: 'vpa', vpa: { address: vpa } }),

    /** Penny-less UPI check: returns the name registered on the UPI ID. */
    async validateVpa(fundAccountId: string, waitMs = 10_000): Promise<{ active: boolean; name: string | null }> {
      type V = { id: string; status: string; results?: { account_status?: string; registered_name?: string | null } };
      let v = await call<V>('POST', '/fund_accounts/validations', { account_number: cfg.accountNumber, fund_account: { id: fundAccountId } });
      const until = Date.now() + waitMs;
      while (v.status === 'created' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 700));
        v = await call<V>('GET', `/fund_accounts/validations/${v.id}`);
      }
      if (v.status !== 'completed') return { active: false, name: null };
      return { active: v.results?.account_status === 'active', name: v.results?.registered_name ?? null };
    },

    /**
     * Sends money. `idempotencyKey` must be the same on every retry of the same
     * withdrawal — Razorpay then returns the original payout instead of paying twice.
     */
    createPayout: (p: { fundAccountId: string; amountPaise: number; referenceId: string; narration: string; idempotencyKey: string; notes?: Record<string, string> }) =>
      call<Payout>(
        'POST',
        '/payouts',
        {
          account_number: cfg.accountNumber,
          fund_account_id: p.fundAccountId,
          amount: p.amountPaise,
          currency: 'INR',
          mode: 'UPI',
          purpose: 'payout',
          queue_if_low_balance: true,
          reference_id: p.referenceId.slice(0, 40),
          narration: p.narration.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 30),
          notes: p.notes ?? {},
        },
        { 'X-Payout-Idempotency': p.idempotencyKey },
      ),

    getPayout: (id: string) => call<Payout>('GET', `/payouts/${id}`),
  };
}

export type RazorpayClient = ReturnType<typeof razorpayClient>;

/** Razorpay signs webhooks with HMAC-SHA256 of the raw body (header X-Razorpay-Signature). */
export function verifyRazorpaySignature(rawBody: string, signature: string | undefined, secret: string) {
  if (!signature) return false;
  const want = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(want);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const FINAL_FAIL: PayoutStatus[] = ['rejected', 'cancelled', 'reversed', 'failed'];
