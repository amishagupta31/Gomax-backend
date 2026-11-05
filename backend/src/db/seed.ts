// Seeds catalogue data (products, gifts, challenges) and the first owner login.
// Safe to re-run: existing rows are left alone.
//   SEED_OWNER_LOGIN / SEED_OWNER_PASSWORD / SEED_OWNER_PIN — first admin
//   SEED_DEMO=1 — also a demo applicator (98765 43210 / gomax123) and an
//                 in-market coupon batch, for local / staging only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDb, type Db } from './client.js';
import { challenges, couponBatches, coupons, gifts, products, staff, users } from './schema.js';
import { hashSecret } from '../lib/crypto.js';
import { generateCode } from '../lib/codes.js';

export const PRODUCTS = [
  {
    id: 'p10', name: 'Pure Tile P10', category: 'adhesive', sort: 1,
    data: { type: 'Tile adhesive', pack: '20 kg bag', jobs: ['floor', 'wall'], tags: ['Inside only'], standards: ['C1T · EN 12004', 'Type 1 · IS 15477', 'ISI mark'], coverage: '45–55 sq ft', setTime: '20 min', mix: 'Water', summary: 'For ceramic tiles on inside walls and floors. Easy to mix and spread.' },
  },
  {
    id: 'p40', name: 'Pure Set P40', category: 'adhesive', sort: 2,
    data: { type: 'Tile adhesive', pack: '20 kg bag', jobs: ['floor', 'wall'], tags: ['Inside + outside'], standards: ['C2TE · EN 12004', 'Type 2 · IS 15477', 'ISI mark', 'German formula'], coverage: '55–70 sq ft', setTime: '30 min', mix: 'Water', summary: 'For vitrified, porcelain and ceramic tiles. Strong grip, and tiles do not slip on walls.' },
  },
  {
    id: 'is100', name: 'Pure Set IS100', category: 'adhesive', sort: 3,
    data: { type: 'Tile adhesive', pack: '20 kg bag', jobs: ['big', 'outside'], tags: ['Terrace + outside', 'Flexible'], standards: ['C2TES1 · EN 12004', 'Type 2 · IS 15477', 'ISI mark'], coverage: '50–60 sq ft', setTime: '25 min', mix: 'Water', summary: 'Flexible adhesive for big tiles, stone and terraces that move with heat.' },
  },
  {
    id: 'hg1200', name: 'Purepoxy HG 1200', category: 'grout', sort: 4,
    data: { type: 'Epoxy grout', pack: '5 kg bucket', jobs: ['joints'], tags: ['Stain proof', 'Many colours'], standards: ['RG · EN 13888', 'Food safe'], coverage: '80–100 sq ft', setTime: '45 min', mix: 'A + B', summary: 'Epoxy grout that fills tile joints, stays clean and does not let water in.' },
  },
  {
    id: 'urp', name: 'Purecrete URP', category: 'waterproofing', sort: 5,
    data: { type: 'Waterproofing', pack: '20 kg can', jobs: ['roof', 'bathroom', 'outside'], tags: ['Repairs'], standards: ['IS 2645'], coverage: '200 ml / bag', setTime: '7 days cure', mix: 'Cement', summary: 'Mix with cement for waterproof plaster and repairs on roofs and walls.' },
  },
  {
    id: 'iwl', name: 'Pure Proof IWL', category: 'waterproofing', sort: 6,
    data: { type: 'Waterproofing', pack: '10 L can', jobs: ['wall'], tags: ['Inside + outside', 'Liquid'], standards: ['IS 2645'], coverage: '200 ml / bag', setTime: '7 days cure', mix: 'Water', summary: 'Integral liquid waterproofing for plaster and concrete.' },
  },
];

// Placeholder list — CLIENT to share the real gifts, runs prices and photos.
export const GIFTS = [
  { id: 'watch', name: 'Smart watch', runsPrice: 60, sort: 1 },
  { id: 'tshirt', name: 'GoMax T-shirt', runsPrice: 80, sizes: ['M', 'L', 'XL', 'XXL'], sort: 2 },
  { id: 'headphones', name: 'Headphones', runsPrice: 150, sort: 3 },
  { id: 'powerbank', name: 'Power bank', runsPrice: 200, sort: 4 },
  { id: 'speaker', name: 'Bluetooth speaker', runsPrice: 450, sort: 5 },
  { id: 'cooker', name: 'Pressure cooker', runsPrice: 600, sort: 6 },
  { id: 'toolkit', name: 'Tool kit', runsPrice: 600, sort: 7 },
];

export const CHALLENGES: (typeof challenges.$inferInsert)[] = [
  {
    id: 'weekly', kind: 'scan_count', period: 'week', tag: 'Weekly', tone: 'runs', art: 'bullseye', sort: 1,
    title: 'Scan 20 coupons this week', shortTitle: 'Scan 20 coupons', goal: 20, rewardRuns: 100, bonusText: '+ “Hafte ka Hero” badge',
    milestones: [{ at: 5, title: 'Scan 5 coupons' }, { at: 10, title: 'Scan 10 coupons', sub: '+1 scratch card', scratchCards: 1 }, { at: 20, title: 'Scan 20 coupons' }],
  },
  { id: 'streak', kind: 'streak_days', period: 'range', tag: 'Daily streak', tone: 'primary', art: 'fire', sort: 2, title: 'Work photo every day', shortTitle: 'Daily work photo streak', goal: 15, rewardRuns: 50 },
  {
    id: 'ultra', kind: 'ultra_scan_count', period: 'range', tag: 'Ultra coupons', tone: 'warning', art: 'gem-stone', sort: 3,
    title: 'Scan 5 Ultra (premium) coupons', shortTitle: 'Scan 5 Ultra coupons', goal: 5, rewardRuns: 150,
    milestones: [{ at: 1, title: 'Scan 1 Ultra coupon' }, { at: 3, title: 'Scan 3 Ultra coupons' }, { at: 5, title: 'Scan 5 Ultra coupons' }],
  },
  { id: 'invite', kind: 'invite_count', period: 'range', tag: 'Invite', tone: 'success', art: 'handshake', sort: 4, title: 'Invite 2 applicators who scan', shortTitle: 'Invite 2 applicators', goal: 2, rewardRuns: 100 },
];

export async function seedCatalogue(db: Db) {
  await db.insert(products).values(PRODUCTS).onConflictDoNothing();
  await db.insert(gifts).values(GIFTS).onConflictDoNothing();
  await db.insert(challenges).values(CHALLENGES).onConflictDoNothing();
}

export async function seedOwner(db: Db, loginId: string, password: string, pin: string) {
  await db
    .insert(staff)
    .values({ loginId: loginId.toLowerCase(), name: 'Owner', role: 'owner', passwordHash: await hashSecret(password), pinHash: await hashSecret(pin) })
    .onConflictDoNothing();
}

export async function seedDemo(db: Db) {
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.mobile, '9876543210'));
  if (!exists) {
    await db.insert(users).values({ name: 'Ram Kumar', mobile: '9876543210', passwordHash: await hashSecret('gomax123'), inviteCode: 'RAM245', city: 'Amritsar' });
  }
  const [batch] = await db
    .insert(couponBatches)
    .values({ ref: 'B-DEMO', valuePoints: 20, quantity: 50, status: 'in_market', expiresAt: new Date(Date.now() + 365 * 86_400_000), inMarketAt: new Date(), note: 'Demo batch' })
    .onConflictDoNothing()
    .returning();
  if (batch) {
    const codes = Array.from({ length: 50 }, (_, i) => ({ code: generateCode(), batchId: batch.id, serial: i + 1 }));
    await db.insert(coupons).values(codes).onConflictDoNothing();
    console.log('demo coupon codes:', codes.slice(0, 5).map((c) => c.code).join(', '), '…');
  }
}

async function main() {
  const config = loadConfig();
  const { db, close } = createDb(config);
  try {
    await seedCatalogue(db);
    const { SEED_OWNER_LOGIN, SEED_OWNER_PASSWORD, SEED_OWNER_PIN, SEED_DEMO } = process.env;
    if (SEED_OWNER_LOGIN && SEED_OWNER_PASSWORD && SEED_OWNER_PIN) await seedOwner(db, SEED_OWNER_LOGIN, SEED_OWNER_PASSWORD, SEED_OWNER_PIN);
    if (SEED_DEMO === '1') await seedDemo(db);
    console.log('seed done');
  } finally {
    await close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
