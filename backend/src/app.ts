import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { FileStore } from './lib/storage.js';
import type { WhatsApp } from './lib/whatsapp.js';
import type { KycProvider } from './lib/kyc.js';
import type { PhoneVerifier } from './lib/firebase.js';
import type { RazorpayClient } from './lib/razorpay.js';
import { AppError } from './lib/errors.js';
import { uniqueViolation } from './lib/pgerrors.js';
import { authPlugin } from './plugins/auth.js';
import authRoutes from './modules/auth.js';
import meRoutes from './modules/me.js';
import couponRoutes from './modules/coupons.js';
import walletRoutes from './modules/wallet.js';
import giftRoutes from './modules/gifts.js';
import withdrawalRoutes from './modules/withdrawals.js';
import productRoutes from './modules/products.js';
import contentRoutes from './modules/content.js';
import gameRoutes from './modules/games.js';
import notificationRoutes from './modules/notifications.js';
import uploadRoutes from './modules/uploads.js';
import webhookRoutes from './modules/webhooks.js';
import jobRoutes from './modules/jobs.js';
import adminRoutes from './modules/admin/index.js';

export type Deps = {
  db: Db;
  config: Config;
  store: FileStore;
  wa: WhatsApp;
  kyc: KycProvider;
  /** Injected clock so tests can move through days. */
  now: () => Date;
  /** Verifies a Cloud Scheduler OIDC token; omitted outside GCP. */
  verifyJobToken?: (token: string) => Promise<boolean>;
  /** Memorystore — shared rate-limit counters. Without it, limits are per instance (dev/tests). */
  redis?: Redis;
  /** Sign-up OTP check (Firebase Phone Auth). Absent = sign-up without OTP (local dev). */
  verifyPhone?: PhoneVerifier;
  /** RazorpayX client — present when Razorpay keys are configured. */
  razorpay?: RazorpayClient;
};

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
  interface FastifyRequest {
    rawBody?: string;
  }
}

export async function buildApp(deps: Deps) {
  const app = Fastify({
    logger:
      deps.config.NODE_ENV === 'test'
        ? false
        : {
            level: deps.config.LOG_LEVEL,
            // Cloud Logging reads `severity`; never log auth headers or passwords.
            formatters: { level: (label) => ({ severity: label.toUpperCase() }) },
            redact: ['req.headers.authorization', 'req.headers["x-jobs-secret"]'],
          },
    trustProxy: true, // Cloud Run sits behind Google's front end
    bodyLimit: 256 * 1024,
  });
  app.decorate('deps', deps);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Keep the raw body for webhook signature checks.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      (e as FastifyError).statusCode = 400;
      done(e as Error, undefined);
    }
  });

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: deps.config.CORS_ORIGINS === '*' ? true : deps.config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    // The plugin's default leaves out PUT, PATCH and DELETE, which the API uses.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  // Per-IP limits (stricter ones are set per route), counted in Redis so they
  // hold across all Cloud Run instances. Off in tests, which make many calls fast.
  if (deps.config.NODE_ENV !== 'test') {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
      ...(deps.redis ? { redis: deps.redis, nameSpace: 'gomax-rl:', skipOnError: true } : {}),
      // Staging load tests (see load/README.md); never set in prod (loadConfig refuses).
      allowList: (req) => Boolean(deps.config.LOADTEST_KEY) && req.headers['x-loadtest-key'] === deps.config.LOADTEST_KEY,
    });
  }

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: 'invalid_input',
          message: 'Some details are missing or wrong',
          issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
      });
    }
    if (uniqueViolation(err) !== null) {
      return reply.status(409).send({ error: { code: 'duplicate', message: 'This was already done. Refresh and check.' } });
    }
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'too_many_requests', message: 'Too many tries. Please wait a minute.' } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'bad_request', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
  });

  // Liveness: the process is up. Readiness (startup probe, deploy gate): DB + Redis reachable.
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    const [db, redis] = await Promise.allSettled([deps.db.execute(sql`select 1`), deps.redis ? deps.redis.ping() : Promise.resolve('skipped')]);
    const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
    return reply.status(ok ? 200 : 503).send({ ok, db: db.status, redis: deps.redis ? redis.status : 'not configured' });
  });

  await app.register(authPlugin);
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(meRoutes);
      await v1.register(couponRoutes);
      await v1.register(walletRoutes);
      await v1.register(giftRoutes);
      await v1.register(withdrawalRoutes);
      await v1.register(productRoutes);
      await v1.register(contentRoutes);
      await v1.register(gameRoutes);
      await v1.register(notificationRoutes);
      await v1.register(uploadRoutes);
      await v1.register(adminRoutes, { prefix: '/admin' });
    },
    { prefix: '/v1' },
  );
  await app.register(webhookRoutes, { prefix: '/webhooks' });
  await app.register(jobRoutes, { prefix: '/internal/jobs' });

  return app;
}
