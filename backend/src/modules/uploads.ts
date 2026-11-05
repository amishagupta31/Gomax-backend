import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireUser } from '../plugins/auth.js';

// The app uploads straight to Cloud Storage with a 10-minute signed PUT URL,
// then sends the object name with the request that uses it.
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ext = (type: string) => (type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'application/pdf' ? 'pdf' : 'jpg');
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const routes: FastifyPluginAsyncZod = async (app) => {
  const { store } = app.deps;

  app.post(
    '/uploads',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { body: z.object({ purpose: z.enum(['streak', 'upi_qr']), contentType: z.enum(IMAGE_TYPES) }) },
    },
    async (req) => {
      const object = `${req.body.purpose}/${req.userId}/${randomUUID()}.${ext(req.body.contentType)}`;
      const signed = await store.signedPut(object, req.body.contentType, MAX_IMAGE_BYTES);
      return { object, ...signed, expiresAt: signed.expiresAt.toISOString() };
    },
  );
};

export default routes;
