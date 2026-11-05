import type { FastifyPluginAsync } from 'fastify';
import authRoutes from './auth.js';
import couponRoutes from './coupons.js';
import moneyRoutes from './withdrawals.js';
import giftRoutes from './gifts.js';
import peopleRoutes from './applicators.js';
import gameRoutes from './games.js';
import systemRoutes from './system.js';
import insightRoutes from './insights.js';
import dealerRoutes from './dealers.js';
import contentRoutes from './content.js';

// GoMax Admin website API (Figma page "03 · Admin"). Pages are hidden by
// role in the UI; every route also checks the role here.
const admin: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(couponRoutes);
  await app.register(moneyRoutes);
  await app.register(giftRoutes);
  await app.register(peopleRoutes);
  await app.register(gameRoutes);
  await app.register(systemRoutes);
  await app.register(insightRoutes);
  await app.register(dealerRoutes);
  await app.register(contentRoutes);
};

export default admin;
