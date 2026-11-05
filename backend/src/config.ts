import { z } from 'zod';

// All runtime config comes from env vars. On Cloud Run the secrets are
// mounted from Secret Manager (see infra/terraform/run.tf); locally use .env.
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Which deployment this is. Some test-only switches refuse to run in prod. */
  APP_ENV: z.enum(['local', 'staging', 'prod']).default('local'),
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.string().default('info'),

  /**
   * Supabase Postgres. Runtime traffic goes through the transaction pooler
   * (Supavisor, port 6543); migrations use DIRECT_URL (session pooler, 5432).
   */
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().optional(),
  /** Supabase root CA (PEM) — turns on full TLS verification. Required in production. */
  DB_CA_CERT: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().default(5),

  /** Memorystore Redis — shared rate-limit counters across Cloud Run instances. */
  REDIS_URL: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** base64 of 32 random bytes — encrypts PAN numbers at rest. */
  PAN_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'PAN_KEY must be 32 bytes, base64'),

  STORAGE_DRIVER: z.enum(['gcs', 'memory']).default('memory'),
  STORAGE_BUCKET: z.string().default('gomax-local'),

  WHATSAPP_DRIVER: z.enum(['meta', 'log']).default('log'),
  WA_TOKEN: z.string().optional(),
  WA_PHONE_NUMBER_ID: z.string().optional(),
  WA_VERIFY_TOKEN: z.string().optional(),
  /** Meta app secret — verifies X-Hub-Signature-256 on webhook calls. */
  WA_APP_SECRET: z.string().optional(),
  /** The GoMax business number users message "RESET <mobile>" to (A1-11). */
  WA_BUSINESS_NUMBER: z.string().default('919215844410'),

  /** UPI name check: mock (dev) or razorpay (RazorpayX fund account validation). */
  KYC_DRIVER: z.enum(['mock', 'razorpay']).default('mock'),

  /**
   * How approved withdrawals are paid: manual (staff pay in the company UPI app
   * and upload proof + UTR) or razorpayx (sent automatically by the payouts job).
   */
  PAYOUT_MODE: z.enum(['manual', 'razorpayx']).default('manual'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  /** RazorpayX business account number payouts are made from. */
  RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),
  /** Secret set on the RazorpayX webhook — verifies X-Razorpay-Signature. */
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  /**
   * Firebase project used for the sign-up SMS OTP. When set, sign-up requires
   * a Firebase ID token proving the mobile number; when empty, it doesn't (local dev).
   */
  FIREBASE_PROJECT_ID: z.string().optional(),

  /** Cloud Scheduler calls /internal/jobs/* with an OIDC token for this audience… */
  JOBS_AUDIENCE: z.string().optional(),
  JOBS_INVOKER_EMAIL: z.string().optional(),
  /** …or, outside GCP, with this shared secret in x-jobs-secret. */
  JOBS_SECRET: z.string().optional(),

  CORS_ORIGINS: z.string().default('*'),
  /**
   * Staging only: requests with header x-loadtest-key = this value skip the
   * API's per-IP rate limiter, so a load generator (one IP) can simulate
   * thousands of users. Refused when APP_ENV = prod.
   */
  LOADTEST_KEY: z.string().min(24).optional(),
  /** Base for links sent on WhatsApp (password reset deep link). */
  APP_LINK_BASE: z.string().default('https://gomax.app'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration — ${msg}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    if (c.STORAGE_DRIVER !== 'gcs') throw new Error('STORAGE_DRIVER must be gcs in production');
    if (!c.JOBS_AUDIENCE && !c.JOBS_SECRET) throw new Error('Set JOBS_AUDIENCE (Cloud Scheduler OIDC) or JOBS_SECRET');
    if (!c.DB_CA_CERT) throw new Error('DB_CA_CERT (Supabase root CA) is required in production');
    if (!c.REDIS_URL) throw new Error('REDIS_URL is required in production (shared rate limits)');
  }
  if (c.PAYOUT_MODE === 'razorpayx' || c.KYC_DRIVER === 'razorpay') {
    const missing = (['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAYX_ACCOUNT_NUMBER'] as const).filter((k) => !c[k]);
    if (c.PAYOUT_MODE === 'razorpayx' && !c.RAZORPAY_WEBHOOK_SECRET) missing.push('RAZORPAY_WEBHOOK_SECRET' as never);
    if (missing.length) throw new Error(`Razorpay is switched on but these are missing: ${missing.join(', ')}`);
  }
  if (c.APP_ENV === 'prod' && c.LOADTEST_KEY) throw new Error('LOADTEST_KEY must never be set in prod');
  return c;
}
