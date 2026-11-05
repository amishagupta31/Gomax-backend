import { OAuth2Client } from 'google-auth-library';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { mockKyc, razorpayKyc } from './lib/kyc.js';
import { razorpayClient } from './lib/razorpay.js';
import { firebasePhoneVerifier } from './lib/firebase.js';
import { createStore } from './lib/storage.js';
import { createWhatsApp } from './lib/whatsapp.js';

const config = loadConfig();
const { db, close } = createDb(config);
const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5000 }) : undefined;
redis?.on('error', (e) => console.error(JSON.stringify({ severity: 'WARNING', message: `redis: ${e.message}` })));

// Cloud Scheduler signs job calls with an OIDC token for JOBS_AUDIENCE.
const oidc = new OAuth2Client();
const verifyJobToken = config.JOBS_AUDIENCE
  ? async (token: string) => {
      try {
        const ticket = await oidc.verifyIdToken({ idToken: token, audience: config.JOBS_AUDIENCE });
        const p = ticket.getPayload();
        return Boolean(p?.email_verified && (!config.JOBS_INVOKER_EMAIL || p.email === config.JOBS_INVOKER_EMAIL));
      } catch {
        return false;
      }
    }
  : undefined;

const razorpay =
  config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET && config.RAZORPAYX_ACCOUNT_NUMBER
    ? razorpayClient({ keyId: config.RAZORPAY_KEY_ID, keySecret: config.RAZORPAY_KEY_SECRET, accountNumber: config.RAZORPAYX_ACCOUNT_NUMBER })
    : undefined;

const app = await buildApp({
  db,
  config,
  store: createStore(config),
  wa: createWhatsApp(config, (m) => console.log(m)),
  kyc: config.KYC_DRIVER === 'razorpay' && razorpay ? razorpayKyc(razorpay) : mockKyc(),
  now: () => new Date(),
  verifyJobToken,
  redis,
  verifyPhone: config.FIREBASE_PROJECT_ID ? firebasePhoneVerifier(config.FIREBASE_PROJECT_ID) : undefined,
  razorpay,
});

// Cloud Run sends SIGTERM before stopping an instance: finish requests, close the pool.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    await close();
    await redis?.quit().catch(() => undefined);
    process.exit(0);
  });
}

// Deep accept queue for sudden bursts (the OS may cap it lower).
await app.listen({ host: '0.0.0.0', port: config.PORT, backlog: 1024 });
