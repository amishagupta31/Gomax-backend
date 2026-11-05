// GoMax database schema (Supabase Postgres 16). Source of truth for
// drizzle-kit; SQL migrations in src/db/migrations are generated from it.
// Amounts are whole numbers: points (1 pt = ₹1), runs, rupees.
//
// Everything lives in the `gomax` schema: Supabase's auto-generated REST API
// only exposes `public`, so these tables are reachable only through this API.
// RLS is also enabled on every table (migration 0002) as a second lock.
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  bigint,
} from 'drizzle-orm/pg-core';

export const gomax = pgSchema('gomax');

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

// ── Enums ────────────────────────────────────────────────────────────────
export const userStatus = gomax.enum('user_status', ['active', 'blocked']);
export const staffRole = gomax.enum('staff_role', ['owner', 'accounts', 'factory', 'helpline', 'ops']);
export const batchStatus = gomax.enum('batch_status', ['generated', 'printed', 'in_market', 'blocked']);
export const scanResult = gomax.enum('scan_result', ['added', 'already_used', 'expired', 'not_active', 'wrong_code', 'blocked']);
export const scanSource = gomax.enum('scan_source', ['scan', 'typed', 'offline']);
export const wallet = gomax.enum('wallet', ['points', 'runs']);
export const ledgerKind = gomax.enum('ledger_kind', [
  'scan', 'bonus', 'withdraw', 'withdraw_refund', 'spin', 'scratch', 'challenge', 'quest',
  'streak', 'invite', 'referral', 'gift', 'gift_refund', 'adjustment',
]);
export const withdrawalStatus = gomax.enum('withdrawal_status', ['requested', 'approved', 'paid', 'rejected', 'failed', 'held']);
export const orderStep = gomax.enum('order_step', ['booked', 'packed', 'shipped', 'delivered', 'cancelled']);
export const cardStatus = gomax.enum('card_status', ['new', 'revealed', 'expired']);
export const challengeKind = gomax.enum('challenge_kind', ['scan_count', 'ultra_scan_count', 'invite_count', 'streak_days']);
export const challengePeriod = gomax.enum('challenge_period', ['week', 'range']);
export const reviewStatus = gomax.enum('review_status', ['pending', 'approved', 'rejected']);
export const noteKind = gomax.enum('note_kind', ['money', 'gifts', 'games', 'invite']);
export const outboxStatus = gomax.enum('outbox_status', ['pending', 'sent', 'failed']);
export const flagStatus = gomax.enum('flag_status', ['open', 'cleared', 'confirmed']);

// ── People ───────────────────────────────────────────────────────────────
export const users = gomax.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mobile: varchar('mobile', { length: 10 }).notNull().unique(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    city: text('city'),
    birthday: date('birthday'),
    anniversary: date('anniversary'),
    language: varchar('language', { length: 2 }).notNull().default('hi'),
    inviteCode: varchar('invite_code', { length: 12 }).notNull().unique(),
    referredBy: uuid('referred_by'),
    status: userStatus('status').notNull().default('active'),
    cashHold: boolean('cash_hold').notNull().default(false),
    whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(true),
    points: integer('points').notNull().default(0),
    runs: integer('runs').notNull().default(0),
    lifetimePoints: integer('lifetime_points').notNull().default(0),
    firstCouponAt: ts('first_coupon_at'),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastDeviceId: text('last_device_id'),
    /** Set when the number was proven with an SMS OTP at sign-up (Firebase Phone Auth). */
    phoneVerifiedAt: ts('phone_verified_at'),
    firebaseUid: text('firebase_uid'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('users_points_nonneg', sql`${t.points} >= 0`),
    check('users_runs_nonneg', sql`${t.runs} >= 0`),
    index('users_referred_by_idx').on(t.referredBy),
    index('users_device_idx').on(t.lastDeviceId),
  ],
);

export const userKyc = gomax.table('user_kyc', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  panEnc: text('pan_enc'),
  panMasked: varchar('pan_masked', { length: 10 }),
  panName: text('pan_name'),
  panVerifiedAt: ts('pan_verified_at'),
  upiId: text('upi_id'),
  upiName: text('upi_name'),
  upiMatchesPan: boolean('upi_matches_pan'),
  upiVerifiedAt: ts('upi_verified_at'),
  /** RazorpayX contact + fund account for the saved UPI ID (created on first payout). */
  rzpContactId: text('rzp_contact_id'),
  rzpFundAccountId: text('rzp_fund_account_id'),
  rzpFundAccountVpa: text('rzp_fund_account_vpa'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const staff = gomax.table('staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  loginId: varchar('login_id', { length: 40 }).notNull().unique(),
  name: text('name').notNull(),
  role: staffRole('role').notNull(),
  mobile: varchar('mobile', { length: 10 }),
  passwordHash: text('password_hash').notNull(),
  pinHash: text('pin_hash').notNull(),
  active: boolean('active').notNull().default(true),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: ts('locked_until'),
  createdAt: createdAt(),
});

export const refreshTokens = gomax.table(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectType: varchar('subject_type', { length: 5 }).notNull(), // 'user' | 'staff'
    subjectId: uuid('subject_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    deviceId: text('device_id'),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_subject_idx').on(t.subjectType, t.subjectId)],
);

export const passwordResets = gomax.table('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

export const helplineRequests = gomax.table('helpline_requests', {
  id: serial('id').primaryKey(),
  mobile: varchar('mobile', { length: 10 }).notNull(),
  userId: uuid('user_id'),
  status: varchar('status', { length: 10 }).notNull().default('open'),
  handledBy: uuid('handled_by'),
  createdAt: createdAt(),
});

// ── Coupons & scans ──────────────────────────────────────────────────────
export const couponBatches = gomax.table('coupon_batches', {
  id: serial('id').primaryKey(),
  ref: varchar('ref', { length: 12 }).notNull().unique(),
  valuePoints: integer('value_points').notNull(),
  /** Product line printed on the pack, e.g. 'standard' | 'ultra' (C2 "Scan 5 Ultra coupons"). */
  line: varchar('line', { length: 20 }).notNull().default('standard'),
  quantity: integer('quantity').notNull(),
  status: batchStatus('status').notNull().default('generated'),
  expiresAt: ts('expires_at').notNull(),
  note: text('note'),
  /** D2b: optional area the batch is sent to (state / district), for reports. */
  area: varchar('area', { length: 40 }),
  blockedReason: text('blocked_reason'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  printedAt: ts('printed_at'),
  inMarketAt: ts('in_market_at'),
});

export const coupons = gomax.table(
  'coupons',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    code: varchar('code', { length: 8 }).notNull().unique(),
    batchId: integer('batch_id').notNull().references(() => couponBatches.id),
    serial: integer('serial').notNull(),
    blocked: boolean('blocked').notNull().default(false),
    scannedBy: uuid('scanned_by'),
    scannedAt: ts('scanned_at'),
  },
  (t) => [uniqueIndex('coupons_batch_serial_uq').on(t.batchId, t.serial), index('coupons_scanned_by_idx').on(t.scannedBy)],
);

export const scans = gomax.table(
  'scans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    codeRaw: text('code_raw').notNull(),
    code: varchar('code', { length: 16 }),
    couponId: bigint('coupon_id', { mode: 'number' }),
    result: scanResult('result').notNull(),
    source: scanSource('source').notNull(),
    points: integer('points').notNull().default(0),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    accuracy: real('accuracy'),
    deviceId: text('device_id'),
    deviceModel: text('device_model'),
    appVersion: text('app_version'),
    scannedAt: ts('scanned_at').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    day: date('day').notNull(),
  },
  (t) => [
    index('scans_user_time_idx').on(t.userId, t.scannedAt),
    index('scans_coupon_idx').on(t.couponId),
    index('scans_code_idx').on(t.code),
    index('scans_user_day_idx').on(t.userId, t.day),
  ],
);

// ── Money: ledger, withdrawals ───────────────────────────────────────────
export const ledger = gomax.table(
  'ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    wallet: wallet('wallet').notNull(),
    kind: ledgerKind('kind').notNull(),
    amount: integer('amount').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    title: text('title').notNull(),
    sub: text('sub'),
    ref: text('ref'),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_user_wallet_time_idx').on(t.userId, t.wallet, t.createdAt), check('ledger_amount_nonzero', sql`${t.amount} <> 0`)],
);

export const withdrawals = gomax.table(
  'withdrawals',
  {
    id: serial('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    amount: integer('amount').notNull(),
    upiId: text('upi_id').notNull(),
    upiName: text('upi_name'),
    upiQrObject: text('upi_qr_object'),
    status: withdrawalStatus('status').notNull().default('requested'),
    reason: text('reason'),
    nameDiffers: boolean('name_differs').notNull().default(false),
    monthKey: varchar('month_key', { length: 7 }).notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    lockedBy: uuid('locked_by'),
    lockedUntil: ts('locked_until'),
    paidBy: uuid('paid_by'),
    paidAt: ts('paid_at'),
    utr: varchar('utr', { length: 12 }).unique(),
    proofObject: text('proof_object'),
    /** manual | razorpayx — fixed when the withdrawal is approved. */
    payoutMode: varchar('payout_mode', { length: 12 }),
    /** RazorpayX payout id (pout_…) and its latest status. */
    payoutRef: text('payout_ref').unique(),
    payoutStatus: varchar('payout_status', { length: 20 }),
    payoutError: text('payout_error'),
    payoutSentAt: ts('payout_sent_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('withdrawals_status_idx').on(t.status, t.createdAt), index('withdrawals_user_idx').on(t.userId, t.monthKey), check('withdrawals_amount_pos', sql`${t.amount} > 0`)],
);

// ── Gifts ────────────────────────────────────────────────────────────────
export const gifts = gomax.table('gifts', {
  id: varchar('id', { length: 40 }).primaryKey(),
  name: text('name').notNull(),
  runsPrice: integer('runs_price').notNull(),
  stock: integer('stock'), // null = unlimited
  active: boolean('active').notNull().default(true),
  photos: jsonb('photos').$type<string[]>().notNull().default([]),
  sizes: jsonb('sizes').$type<string[]>().notNull().default([]),
  marketValueInr: integer('market_value_inr'),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
});

export type Address = { name: string; mobile: string; street: string; city: string; pin: string };

export const giftOrders = gomax.table(
  'gift_orders',
  {
    id: serial('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    giftId: varchar('gift_id', { length: 40 }).notNull().references(() => gifts.id),
    size: text('size'),
    runs: integer('runs').notNull(),
    address: jsonb('address').$type<Address>().notNull(),
    step: orderStep('step').notNull().default('booked'),
    bookedAt: createdAt(),
    packedAt: ts('packed_at'),
    shippedAt: ts('shipped_at'),
    deliveredAt: ts('delivered_at'),
    cancelledAt: ts('cancelled_at'),
    courierName: text('courier_name'),
    awb: text('awb'),
    trackingUrl: text('tracking_url'),
    eta: date('eta'),
    deliveryPhotoObject: text('delivery_photo_object'),
    receivedBy: text('received_by'),
  },
  (t) => [index('gift_orders_user_idx').on(t.userId), index('gift_orders_step_idx').on(t.step, t.bookedAt)],
);

// ── Games ────────────────────────────────────────────────────────────────
export const spins = gomax.table(
  'spins',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    day: date('day').notNull(),
    prizeRuns: integer('prize_runs').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('spins_user_day_idx').on(t.userId, t.day)],
);

export const scratchCards = gomax.table(
  'scratch_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    earnedDay: date('earned_day').notNull(),
    status: cardStatus('status').notNull().default('new'),
    prizeKind: wallet('prize_kind').notNull(),
    prizeAmount: integer('prize_amount').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revealedAt: ts('revealed_at'),
    source: varchar('source', { length: 60 }).notNull().default('coupons'),
    createdAt: createdAt(),
  },
  // At most one coupon card a day; challenge-reward cards use their own source.
  (t) => [uniqueIndex('scratch_user_day_src_uq').on(t.userId, t.earnedDay, t.source), index('scratch_user_idx').on(t.userId, t.status)],
);

export type Milestone = { at: number; title: string; sub?: string; scratchCards?: number };

export const challenges = gomax.table('challenges', {
  id: varchar('id', { length: 40 }).primaryKey(),
  kind: challengeKind('kind').notNull(),
  period: challengePeriod('period').notNull(),
  tag: text('tag').notNull(),
  tone: varchar('tone', { length: 10 }).notNull().default('runs'),
  title: text('title').notNull(),
  shortTitle: text('short_title').notNull(),
  goal: integer('goal').notNull(),
  rewardRuns: integer('reward_runs').notNull(),
  rewardScratchCards: integer('reward_scratch_cards').notNull().default(0),
  bonusText: text('bonus_text'),
  art: varchar('art', { length: 40 }).notNull().default('bullseye'),
  milestones: jsonb('milestones').$type<Milestone[]>().notNull().default([]),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
});

export const challengeClaims = gomax.table(
  'challenge_claims',
  {
    id: serial('id').primaryKey(),
    challengeId: varchar('challenge_id', { length: 40 }).notNull(),
    userId: uuid('user_id').notNull(),
    periodKey: varchar('period_key', { length: 20 }).notNull(),
    runs: integer('runs').notNull(),
    claimedAt: createdAt(),
  },
  (t) => [uniqueIndex('challenge_claims_uq').on(t.challengeId, t.userId, t.periodKey)],
);

export const questClaims = gomax.table(
  'quest_claims',
  {
    id: serial('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    day: date('day').notNull(),
    quest: varchar('quest', { length: 20 }).notNull(),
    runs: integer('runs').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('quest_claims_uq').on(t.userId, t.day, t.quest)],
);

export const streakPhotos = gomax.table(
  'streak_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    day: date('day').notNull(),
    object: text('object').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    takenAt: ts('taken_at').notNull(),
    status: reviewStatus('status').notNull().default('pending'),
    reason: text('reason'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('streak_user_day_uq').on(t.userId, t.day), index('streak_status_idx').on(t.status, t.createdAt)],
);

export const streakRewards = gomax.table(
  'streak_rewards',
  {
    id: serial('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    milestone: integer('milestone').notNull(),
    runStart: date('run_start').notNull(),
    runs: integer('runs').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('streak_rewards_uq').on(t.userId, t.milestone, t.runStart)],
);

// ── Referrals ────────────────────────────────────────────────────────────
export const referralCredits = gomax.table(
  'referral_credits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    earnerId: uuid('earner_id').notNull(),
    fromUserId: uuid('from_user_id').notNull(),
    level: integer('level').notNull(), // 0 = first-coupon bonus, 1..4 = share
    scanId: bigint('scan_id', { mode: 'number' }),
    runs: integer('runs').notNull(),
    monthKey: varchar('month_key', { length: 7 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('referral_earner_month_idx').on(t.earnerId, t.monthKey), uniqueIndex('referral_bonus_uq').on(t.earnerId, t.fromUserId, t.level, t.scanId)],
);

// ── Messaging ────────────────────────────────────────────────────────────
export type NoteLink = { route: string; params?: Record<string, unknown> };

export const notifications = gomax.table(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    kind: noteKind('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    art: varchar('art', { length: 40 }),
    link: jsonb('link').$type<NoteLink>(),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const waOutbox = gomax.table(
  'wa_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id'),
    toMobile: varchar('to_mobile', { length: 10 }).notNull(),
    template: varchar('template', { length: 60 }).notNull(),
    vars: jsonb('vars').$type<Record<string, string>>().notNull().default({}),
    status: outboxStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sendAfter: ts('send_after').notNull().defaultNow(),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [index('wa_outbox_pending_idx').on(t.status, t.sendAfter)],
);

// ── Fraud, products, settings, audit ────────────────────────────────────
export const fraudFlags = gomax.table(
  'fraud_flags',
  {
    id: serial('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    rule: varchar('rule', { length: 30 }).notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    status: flagStatus('status').notNull().default('open'),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('fraud_flags_status_idx').on(t.status, t.createdAt), index('fraud_flags_user_idx').on(t.userId)],
);

export const products = gomax.table('products', {
  id: varchar('id', { length: 40 }).primaryKey(),
  name: text('name').notNull(),
  category: varchar('category', { length: 30 }).notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  tdsObject: text('tds_object'),
  tdsBytes: integer('tds_bytes'),
  tdsUpdatedAt: ts('tds_updated_at'),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const settings = gomax.table('settings', {
  key: varchar('key', { length: 60 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const auditLog = gomax.table(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorType: varchar('actor_type', { length: 10 }).notNull(), // staff | user | system
    actorId: uuid('actor_id'),
    action: varchar('action', { length: 60 }).notNull(),
    entity: varchar('entity', { length: 40 }).notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_entity_idx').on(t.entity, t.entityId), index('audit_time_idx').on(t.createdAt)],
);

// ── Dealers (D10) ────────────────────────────────────────────────────────
// Dealers cannot sign up: an owner makes the login (GMD-<area>-<no>) with a
// temporary password, shared with the dealer on WhatsApp. The dealer login
// itself (scans in their area, view only) comes with the dealer app — phase 2.
export const dealers = gomax.table(
  'dealers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loginId: varchar('login_id', { length: 24 }).notNull().unique(),
    firm: text('firm').notNull(),
    ownerName: text('owner_name').notNull(),
    mobile: varchar('mobile', { length: 10 }).notNull(),
    gst: varchar('gst', { length: 15 }),
    area: varchar('area', { length: 10 }).notNull(),
    areaTeam: text('area_team'),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    tempPasswordExpiresAt: ts('temp_password_expires_at'),
    active: boolean('active').notNull().default(true),
    deactivatedReason: text('deactivated_reason'),
    lastLoginAt: ts('last_login_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('dealers_area_idx').on(t.area)],
);

// ── Home content (D8a) ───────────────────────────────────────────────────
// Cards on the app Home and the "How GoMax works" / T&C pages, in 3 languages.
export type Lang3 = { en: string; hi?: string; pa?: string };
export const homeCards = gomax.table('home_cards', {
  id: serial('id').primaryKey(),
  title: jsonb('title').$type<Lang3>().notNull(),
  body: jsonb('body').$type<Lang3>().notNull(),
  art: varchar('art', { length: 40 }).notNull().default('sparkles'),
  /** first_7_days | from_2nd_visit | always | date_range */
  rule: varchar('rule', { length: 16 }).notNull().default('always'),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  link: varchar('link', { length: 60 }),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const contentPages = gomax.table('content_pages', {
  /** how_it_works | terms */
  key: varchar('key', { length: 30 }).primaryKey(),
  body: jsonb('body').$type<Lang3>().notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
