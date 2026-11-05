# GoMax – Backend Architecture & API

Owner: Amisha Gupta · Updated 19 Oct 2026 · Code: `backend/` · Runbook: [README.md](README.md)

## 1. Summary

GoMax rewards tile applicators for scanning the coupon inside every GoMax pack. Scans earn **points** (1 point = ₹1, withdrawn to UPI) and **runs** (spent on gifts, earned in games, challenges and referrals). The backend serves two clients:

- the **Applicator app** (Expo / React Native, `mobile-app/src/v3`), screens A1–C4 in Figma page "02 · Applicator design";
- the **Admin website** (admin.gomax.in, desktop + phone), Figma page "03 · Admin".

**Stack:** Node.js 22 + Fastify 5 + TypeScript, with the database on **Supabase Postgres** and everything else on **Google Cloud**: Cloud Run, Memorystore Redis, Cloud Storage, Secret Manager, Cloud Scheduler, Cloud Armor and Cloud Build.

The design follows three rules:

1. **Money is never wrong.** Every points/runs movement is one ledger row written in the same transaction as the balance change. Balances cannot go below zero (a database constraint), and two people scanning the same code at once can't both win (a row lock).
2. **Fast and steady under load.** The servers keep no state and scale from 2 to 20 instances. The work queues (WhatsApp, summaries) run outside the request, and a deploy never drops traffic.
3. **Secure in layers:**
   - every input is validated
   - SQL is always parameterised
   - secrets live only in Secret Manager
   - the database is closed to Supabase's public API
   - Cloud Armor sits at the edge
   - every staff action goes to an append-only audit log

## 2. Architecture

```
 Applicator app (Expo)            Admin website
        │ HTTPS + JWT                  │ HTTPS + JWT (staff + PIN)
        ▼                              ▼
 Cloud Load Balancer + Cloud Armor  (api.gomax.app — WAF, per-IP cap, DDoS)
        ▼
 Cloud Run: gomax-api  (Fastify, 2–20 instances, Mumbai)
   /v1/*  app      /v1/admin/*  staff      /webhooks/whatsapp      /internal/jobs/*
        │                  │                       │                       ▲
        │ TLS (CA-checked) │ private VPC           │ signed URLs           │ OIDC
        ▼                  ▼                       ▼                       │
 Supabase Postgres 16   Memorystore Redis 7    Cloud Storage (private)   Cloud Scheduler
 (ap-south-1 Mumbai,    (shared rate limits)   photos, payment proofs,   (outbox every min,
  Supavisor pooler)                            delivery photos, TDS PDFs  9 pm summary, …)
        │
        └── wa_outbox table ──► outbox job ──► Meta WhatsApp Cloud API
```

**Modular monolith.** One deployable with clear domain folders: `modules/` for HTTP, `services/` for business rules, `lib/` for shared code. At this scale, splitting into microservices would add network hops and operations work for no gain. Any module can be extracted later without a rewrite.

| Module | What it owns |
|---|---|
| `auth` | Sign-up (number proven once by SMS OTP via Firebase Phone Auth) with referral code; mobile + password login (no OTP); refresh rotation; WhatsApp/helpline password reset |
| `me` | Profile, Home summary, rank, referrals, PAN / UPI (KYC) |
| `coupons` | Scan (redeem) and scan history |
| `wallet` | Balances, ledger / history |
| `gifts` | Catalogue and gift orders |
| `withdrawals` | Points → UPI requests |
| `products` | Product info and TDS PDFs (no prices, no points) |
| `games` | Spin wheel, scratch cards, challenges, daily quests, photo streak, games history |
| `notifications` | In-app inbox |
| `uploads` | Signed upload URLs |
| `webhooks` | WhatsApp inbound (password reset), delivery receipts |
| `jobs` | Outbox sender, daily summary, streak check, housekeeping, KYC reminder |
| `admin/*` | Coupons & scans, fraud flags, withdrawals & manual UPI payout, gifts & courier, applicators & referral tree, challenges & streak review, products, settings, audit, staff |

## 3. Technology choices

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS | Async I/O suits a request-heavy API; same language as the app |
| Framework | Fastify 5 | Fast, plugin-based, schema validation built in |
| Language | TypeScript (strict) | One type system from database row to response |
| Validation | Zod (`fastify-type-provider-zod`) | Every body, query and param is checked before the handler runs, and unknown fields are dropped |
| Database | **Supabase Postgres 16**, Mumbai | Managed Postgres with point-in-time recovery, dashboard and branching |
| Pooling | Supavisor transaction pooler (6543) at runtime; session pooler (5432) for migrations | Many Cloud Run instances share a small set of DB connections |
| Query layer | **Drizzle ORM** + SQL migration files | Typed queries compiled to parameterised SQL and run directly on `pg`, with no separate query engine and no cold-start cost (the reason the original doc chose Kysely applies equally) |
| Cache / limits | **Memorystore Redis 7** | Rate-limit counters shared by all instances; settings are cached in-process for 30 s |
| Files | Cloud Storage, private, V4 signed URLs | Files never pass through the API, and nothing is public |
| Background work | `wa_outbox` table + Cloud Scheduler | The message is written in the same transaction as the event, so it's never lost and never sent for a rolled-back action. Pub/Sub can replace it later if volume needs it |
| Auth | Own JWT (HS256, `jose`) + rotating refresh tokens; argon2id hashes | Figma requires mobile + password with no OTP, and staff use email + password, with a PIN before money approvals. Supabase Auth isn't used |
| Secrets | GCP Secret Manager → Cloud Run env | No secrets in code, images or `.env` files in production |
| Containers / CI | Docker → Artifact Registry, Cloud Build | Test → image → migrate → 0%-traffic deploy → shift |
| Infra as code | Terraform (`infra/terraform`) | Staging and prod built the same way |
| Tests | Vitest + PGlite (real Postgres in-process) | 131 API tests (incl. 24 authentication-attack tests, 12 sign-up OTP tests, 13 RazorpayX payout tests, 12 admin-website tests, 16 high-traffic race tests and 11 real-user journeys) in about 1 min, no database to install; the same suite also runs on a real Postgres via `TEST_DATABASE_URL` |

## 4. Data model

All tables live in the **`gomax` schema**, not `public`. Supabase's auto-generated REST and GraphQL APIs only expose `public`, so GoMax data can only be reached through this API. Migration `0002_lockdown` adds two more locks:
- row-level security is on for every table, with no policies, which means deny-all for Supabase's `anon` and `authenticated` roles;
- those roles have every grant on the schema revoked.

The API connects as the table owner, so these locks don't affect it. The separate schema also means GoMax can share a Supabase project with the old V1 tables (`coupons`, `orders`…) without clashing, although a dedicated project per environment is recommended.

Conventions:
- UUID ids for people, numeric ids for high-volume rows and human-facing numbers (W-1001, G-1001);
- `timestamptz` everywhere;
- whole-number amounts;
- "day" means the India calendar day (12 am to 12 am IST).

| Area | Tables |
|---|---|
| People | `users` (balances, rank points, invite code, referrer, cash hold) · `user_kyc` (PAN encrypted with AES-256-GCM, plus a masked copy; UPI and name match) · `staff` (role, password + PIN hashes) · `refresh_tokens` · `password_resets` · `helpline_requests` |
| Coupons | `coupon_batches` (value, product line, Generated → Printed → In market / Blocked, expiry) · `coupons` (8-character code, unique across all batches) · `scans` (**every try**, including failures: result, source, GPS, device, app version) |
| Money | `ledger` (append-only movements; `balance_after` on each row) · `withdrawals` (request → approve → lock → paid with unique UTR + proof) |
| Gifts | `gifts` · `gift_orders` (Booked → Packed → Shipped → Delivered / Cancelled) |
| Games | `spins` · `scratch_cards` (prize fixed when the card is made) · `challenges` · `challenge_claims` · `quest_claims` · `streak_photos` · `streak_rewards` |
| Referrals | `referral_credits` (level 0 = first-coupon bonus, levels 1–4 = team share; used for the monthly cap) |
| Messaging | `notifications` · `wa_outbox` |
| Control | `fraud_flags` · `settings` (all limits, odds and rewards) · `products` · `audit_log` (a trigger blocks UPDATE and DELETE) |

Integrity is enforced in the database:
- `CHECK (points >= 0)`, `CHECK (runs >= 0)` and non-zero ledger amounts;
- unique coupon codes, UTRs, invite codes and mobiles;
- one coupon scratch card and one streak photo per user per day;
- one claim per challenge per period.

The schema source is `src/db/schema.ts`; migrations are in `src/db/migrations/`.

## 5. Business rules (enforced on the server)

| Rule | Source |
|---|---|
| Login = mobile + password, no OTP; 3 wrong tries pause it for 30 min | A1 |
| Password reset: the user sends "RESET <mobile>" on WhatsApp **from that number**, then gets a one-time link valid for 15 min; all sessions are signed out | A1-11/12, C4-11 |
| Coupon accepted only if in an "In market" batch, not blocked, not expired, not used; every try is logged | D2, D3 |
| First coupon ever: +25 bonus points | A3-04 |
| Withdraw: PAN + UPI verified, UPI name matches PAN, minimum 500, at most ₹5,000 per request and ₹15,000 per IST month; the request locks the points, and a reject or failure returns them | B3, D4 |
| Manual UPI payout: approve with PIN, lock the row for 15 min, upload screenshot + 12-digit unique UTR, mark paid; WhatsApp at each step | D11, M7 |
| RazorpayX payout (`PAYOUT_MODE=razorpayx`): approve with PIN, then RazorpayX sends the money and the bank UTR comes back by webhook; no manual lock / proof / mark-paid (see §7b) | D4, D11 |
| Gift: runs taken at booking and returned on cancel; delivery needs a photo + who received it | D5, M4 |
| Spins: 3/4/5 a day by rank, reset at 12 am IST; odds on the server only; **100 runs can never be drawn** (blocked in Settings and in code) | C2, D7 |
| Scratch card: the 10th coupon of the day gives one card; at most one a day; expires in 7 days | C2, D7 |
| Photo streak: camera photo taken within the last 15 min, one per day; a rejected photo drops that day; a missed day restarts the streak; rewards at 15/30/45/90/120 days | C2, D7 |
| Referral (in runs): +50 when a direct friend adds their first coupon; levels 1–4 each earn 10% of the points the friend scans; capped at 200 a month per earner; nothing paid if inviter and friend use the same phone | C3, D6 |
| Ranks by lifetime points (never drop): Naya Saathi 0 · Kaarigar 500 · Ustaad 2,000 · GoMax Legend 5,000; +10%/+20% runs on challenge, quest and streak rewards | C3-02 |
| Fraud flags (>15 scans in 5 min, GPS jump >50 km in 30 min, a used code tried by another account, 2 accounts on 1 phone, many wrong codes) put cash **on hold** until an owner clears them | D1, D3 |

All the numbers above live in the `settings` table (Admin → Settings), so a change needs no release.

## 6. Authentication & roles

```
POST /v1/auth/login {mobile, password}
  → access token (JWT, 15 min) + refresh token (random, stored hashed; 90 days app / 1 day staff)
Requests: Authorization: Bearer <access token>
POST /v1/auth/refresh {refreshToken}
  → new pair; the old refresh token is revoked (reuse fails)
```

- **Where the refresh token lives:** in the request body, stored on the phone in SecureStore. The doc's httpOnly cookie doesn't work for a native app. The Admin website keeps it in memory, and staff refresh tokens last one day.
- **Staff login:** email + password. 5 wrong tries lock the login for 30 minutes. The 4-digit PIN is asked before any money approval; wrong PINs there count toward the same lockout, and a lockout also ends sessions that are already open.
- **Roles** are checked on every admin route, and owners can do everything:

| Role | Can do |
|---|---|
| `owner` | Everything, including settings, batches, cash holds, goodwill adjustments, staff logins and the audit log |
| `accounts` | Withdrawals and payouts, KYC, viewing a full PAN (audited) |
| `factory` | Batch print status and CSV export, gift packing, shipping and delivery |
| `helpline` | Lookups, scans log, flags (view), applicators (view) |
| `ops` | Streak photo review |

**Sign-up OTP (Firebase Phone Auth).** At sign-up only, the app sends an SMS OTP with the Firebase SDK and passes the resulting Firebase ID token to `POST /v1/auth/signup`. The API checks it against Google's public keys:
- RS256 signature;
- issuer and audience for `FIREBASE_PROJECT_ID`;
- the sign-in was a phone OTP;
- the OTP was entered within the last 10 minutes;
- the number is Indian.

**The number in the token must match the number being registered.** The account records `phone_verified_at` and `firebase_uid`. Firebase is used only to prove the number; GoMax issues its own tokens, and every login after that is mobile + password. Without `FIREBASE_PROJECT_ID` (local dev) sign-up works without OTP.

**Ownership.** Every app query is scoped to the signed-in user (`WHERE user_id = <token subject>`), and objects carry the owner's id (`streak/<userId>/…`). This is the role row-level security plays in the original doc. The database RLS is the extra lock against Supabase's own client roles.

## 7. API

**Conventions**
- Base URL `https://api.gomax.app/v1` (staging: the Cloud Run URL).
- JSON in and out. Success responses return the resource directly.
- Errors are always `{ "error": { "code", "message", …extra } }`. `code` is stable for the app to branch on (`wrong_password`, `paused`, `insufficient_balance`, `month_limit`, `no_spins_left`, …). `message` is plain text that can be shown on screen.
- Lists use **cursor pagination**: pass `?limit=` (≤ 200) and `?cursor=` from the previous page's `nextCursor`, which is `null` on the last page. There is no OFFSET.
- Rate limits are counted per IP in Redis: 300 a minute overall, and 5–40 a minute on login, sign-up, scan, KYC and payout routes. Cloud Armor adds an edge cap of 600 a minute per IP.

**App**

| Area | Endpoints |
|---|---|
| Auth (A1) | `POST /auth/signup` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/referral/:code` · `GET /auth/registered?mobile` · `POST /auth/reset-request` · `POST /auth/reset-password` |
| Me & home (A2/A3, C4-01) | `GET /home` · `GET /me` · `PATCH /me` · `GET /me/rank` · `GET /me/referrals` · `POST /me/kyc/pan` · `POST /me/kyc/upi/check` · `PUT /me/kyc/upi` |
| Scan (B1) | `POST /coupons/redeem` → `{kind: added \| used \| invalid \| expired \| not_active \| blocked, value, bonus, balance, today, reward, rankUp}` · `GET /me/scans` |
| Wallet & gifts (B2/B4) | `GET /wallet` · `GET /ledger` · `GET /gifts` · `POST /gift-orders` · `GET /gift-orders` · `GET /gift-orders/:id` |
| Withdraw (B3) | `POST /withdrawals` · `GET /withdrawals` · `GET /withdrawals/:id` |
| Products (C1) | `GET /products` · `GET /products/:id` · `GET /products/:id/tds` |
| Games (C2) | `GET /spins/today` · `POST /spins` · `GET /scratch-cards` · `POST /scratch-cards/:id/reveal` · `GET /challenges` · `GET /challenges/:id` · `POST /challenges/:id/claim` · `GET /quests` · `GET /streak` · `POST /streak/photo` · `GET /games/history` |
| Notifications (C4-02) | `GET /notifications` · `POST /notifications/read` |
| Uploads | `POST /uploads {purpose: streak \| upi_qr}` → signed PUT URL |

**Admin (`/v1/admin`)**
- **Login and home:** `auth/login` · `auth/refresh` · `auth/me` · `dashboard` · `dashboard/insights` (14-day chart, active in 30 days, top applicators)
- **Coupons and fraud:** `coupon-batches` (list, create with optional area, status, `print.pdf` — 48 per A4 with QR + cut marks, `export.csv`) · `coupons/:code` (lookup, block) · `scans` · `fraud-flags` (list, decide)
- **Money:** `withdrawals` (queue/history, `qr`, approve, hold, reject, lock, mark-paid, send-back, fail)
- **Gifts:** `gifts` (list, create, update) · `gift-orders` (board, pack, ship, deliver, cancel)
- **People:** `applicators` (search with `view` = active · kyc · no_pan · blocked · hold, profile, `pan`, `tree`, hold, block, adjust, `reset-password` (WhatsApp link), `unlock`, `kyc-ok`) · `helpline-requests` (list, done) · `referrals/top`
- **Dealers (D10):** `dealers` (list, create → Login ID `GMD-<area>-<no>` + temporary password shown once, update, `reset-password`, `deactivate`, `reactivate`). Dealer sign-in is phase 2.
- **Games:** `challenges` (list, create, update) · `streak-photos` (queue, review)
- **Content and system:** `content` (Home cards + How GoMax works / T&C in 3 languages; the app reads `GET /v1/content`) · `products` · `settings/:key` · `audit` (owners: all; Accounts: money rows) · `staff` · `uploads`

**Other routes**
- `GET /healthz` is the liveness check.
- `GET /readyz` checks Supabase and Redis; it's the startup probe and the uptime check.
- `GET|POST /webhooks/whatsapp` takes Meta's webhook, verified with HMAC-SHA256.
- `POST /internal/jobs/:job` runs a scheduled job; only Cloud Scheduler's OIDC token is accepted.

## 7b. Payouts (RazorpayX)

`PAYOUT_MODE` decides how approved withdrawals are paid. `manual` (the default) is the M7 flow: staff pay in the company UPI app, then upload proof and the UTR. `razorpayx` pays automatically through RazorpayX Payouts. The mode is fixed on each withdrawal when it is approved, so switching modes never affects one already in progress.

```
staff approve (PIN) ─▶ payouts job (every 10 min) ─▶ RazorpayX POST /payouts  (UPI, amount in paise)
                                                         │
             Razorpay webhook payout.* ◀─────────────────┘   (+ sync: GET /payouts/:id after 30 min)
                │
   processed ─▶ Paid, bank UTR, notification + WhatsApp withdrawal_paid
   failed / rejected / cancelled / reversed ─▶ Failed, points returned once, WhatsApp withdrawal_failed
```

- **Never pays twice.** Every payout uses the idempotency key `gomax-W-<id>` (`X-Payout-Idempotency`) and `reference_id W-<id>`. A retry after a timeout or a crash gets the same payout back. Rows are claimed with `SKIP LOCKED`, so two job runs never take the same one.
- **Errors.** If RazorpayX is down or refuses, the withdrawal stays approved and staff see `payoutStatus: error` with the message. The next run retries with the same key.
- **Webhook** `POST /webhooks/razorpay`, with the `X-Razorpay-Signature` check (HMAC-SHA256 of the raw body using `RAZORPAY_WEBHOOK_SECRET`). A bad signature gets 403. Repeat deliveries change nothing.
- **A missed webhook** is caught by the same job: payouts still in flight after 30 minutes are checked with `GET /payouts/:id`.
- **Reversed after paid** (the bank bounced it back) marks the withdrawal failed and returns the points.
- **Staff guards.** On RazorpayX rows, lock and mark-paid return 409 `auto_payout`. Once the payout is sent, reject, send-back and fail return 409 `sent_to_razorpay`.
- **Contacts.** Each person gets one RazorpayX contact and one UPI fund account, created on their first payout and reused (`user_kyc.rzp_*`). A new one is made only if their UPI changes.
- **UPI name check** (`KYC_DRIVER=razorpay`) uses RazorpayX Fund Account Validation, which returns the name registered on the UPI ID. It costs about ₹2–3 a check. PAN stays a format check until a PAN provider is chosen.
- **IP whitelist.** RazorpayX only accepts payout calls from whitelisted IPs. Terraform (`nat.tf`) sends Cloud Run's outbound traffic through Cloud NAT with one fixed IP (`terraform output egress_ip`).

| Env | Where it comes from |
|---|---|
| `PAYOUT_MODE` | `manual` or `razorpayx` (Terraform `payout_mode`) |
| `KYC_DRIVER` | `mock` or `razorpay` (Terraform `kyc_driver`) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay Dashboard → Account & Settings → API Keys (secrets `gomax-razorpay-key-id` / `-key-secret`) |
| `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX → My Account, the account money is paid from (Terraform `razorpayx_account_number`) |
| `RAZORPAY_WEBHOOK_SECRET` | The secret you type when adding the webhook in RazorpayX (secret `gomax-razorpay-webhook-secret`) |

The server refuses to start if Razorpay is switched on while any of these are missing.

## 8. Files (Cloud Storage)

The client asks the API for a signed URL, uploads straight to Cloud Storage, then sends the object name with the request that uses it. The API checks the object exists and belongs to that user.

| Prefix | Who writes | Kept |
|---|---|---|
| `streak/<userId>/…` | App (camera photo) | 400 days, then deleted |
| `upi_qr/<userId>/…` | App (withdraw) | Versioned |
| `payment_proof/<day>/…` | Admin (accounts) | Versioned |
| `delivery_photo/<day>/…` | Admin (factory) | Versioned |
| `tds/<day>/…` | Admin (owner) | Versioned |

The bucket is private:
- public access is blocked;
- uploads are limited to 8 MB (20 MB for admin) through a signed header;
- download links last 1 hour;
- CORS is open only to the admin site.

## 9. Performance & scale

- **Target:** 20,000 concurrent users at launch. With 5–20 s between taps that's about 1,700 requests a second.
- **Measured** (local load test, 23 Oct 2026; details in [load/README.md](load/README.md)): one instance handles **≈140 requests/s** of the real app mix before requests start to queue. Even past that it returns 0 server errors and no wrong answers. So the target needs **≈15 instances**; prod allows up to 30, with 2 always on. Confirm on staging.
- **The API's CPU is the first limit**, not the database: during the test no query took over 100 ms. Home was cut from ~13 database round trips to 5, which made it ~30× faster at the same load.
- **Database:**
  - connections = `max_instances × db_pool_per_instance`, 30 × 5 = 150 in prod, which must stay under the Supabase pooler's client limit for the chosen compute size;
  - the scan transaction is the heaviest request, at about 15 queries in one transaction;
  - it locks only the coupon row being scanned, so scans of different codes never wait on each other.
- **Indexes** cover every hot filter: user + time on scans and ledger, coupon code, status queues, and referral earner + month.
- **Caching:**
  - settings are cached per instance for 30 s and cleared immediately on save;
  - rate-limit counters are in Redis;
  - user-specific data is not cached (it changes on every scan).
- **Kept out of the request:** WhatsApp sends go through the outbox job; the daily summary is one message a day per scanner, not one per scan (D8).
- **Region:** Cloud Run (asia-south1) and Supabase (ap-south-1) are both in Mumbai, which keeps database round trips short.

## 10. Security

| Layer | What's in place |
|---|---|
| Edge | Cloud Armor: per-IP throttle, OWASP SQL-injection / XSS rules, adaptive DDoS protection. The `*.run.app` URL is closed when a domain is set |
| Transport | HTTPS only (managed certificate, HTTP → HTTPS redirect). The API ↔ Supabase link is TLS, verified against Supabase's CA (required in production). Redis sits on a private VPC IP with a password |
| Input | Zod on every route, with unknown fields dropped. Body limit 256 KB |
| Queries | Parameterised SQL only (Drizzle); no string-built SQL |
| Identity | argon2id for passwords and PINs; short-lived JWT; refresh rotation; lockouts; PIN re-check for money |
| Data | PAN encrypted with AES-256-GCM (key in Secret Manager); full PAN only to accounts/owner, and every view is audited. Mobile numbers are masked for helpline staff |
| Database | Separate `gomax` schema, RLS on, Supabase client roles revoked, append-only audit log, non-negative balance checks |
| Secrets | Secret Manager only. Cloud Run uses its service account, so there are no key files. Logs never include the auth header |
| Webhooks / jobs | WhatsApp and Razorpay signature checks (HMAC-SHA256, constant-time compare). Scheduler jobs need a Google-signed OIDC token for a fixed audience and service account |
| Abuse | Rate limits, fraud flags with cash hold, a unique UTR, and a row lock on scans |

## 11. Background jobs

| Job | Schedule (IST) | Does |
|---|---|---|
| `outbox` | every minute | Sends queued WhatsApp templates. Retries after 1, 2, 4 and 8 minutes, then marks the message failed. Uses `SKIP LOCKED`, so overlapping runs never double-send |
| `daily-summary` | 9:00 pm | One "today: N coupons" WhatsApp per person who scanned today |
| `streak-check` | 12:05 am | WhatsApp to people whose photo streak just broke |
| `housekeeping` | hourly | Expires scratch cards and releases stale payout locks |
| `kyc-reminder` | Monday 10:00 am | "Add UPI to get your cash" for people with 500+ points and no UPI |
| `payouts` | every 10 min (`payouts_schedule`), only when `payout_mode = razorpayx` | Sends approved withdrawals to RazorpayX and checks payouts still in flight after 30 min (§7b) |

The 17 WhatsApp templates and their variable order are listed in `src/lib/whatsapp.ts`. Each needs Meta approval in 3 languages.

## 12. Errors, logs, monitoring

- **Logs:** structured JSON through Fastify's built-in logger, using Cloud Logging severity. Authorization and job-secret headers are redacted. Unexpected errors are logged with a stack trace and return a generic 500 message.
- **Alerts** go by email (`alert_email`):
  - `/readyz` uptime check failing for 2 minutes;
  - 5xx rate above 1% for 5 minutes;
  - p99 latency above 1 second for 10 minutes.
- **Probes:** a revision only receives traffic after `/readyz` passes, and liveness checks `/healthz`.

## 13. Deployment

```
git push → Cloud Build (cloudbuild.yaml):
  npm ci → typecheck → 131 tests
  → docker build → push to Artifact Registry
  → run migrations (Cloud Run Job gomax-migrate, session pooler)
  → deploy new revision with 0% traffic (tag "candidate"; must pass /readyz)
  → shift 100% traffic to it
```

A failed test, migration or readiness check stops the release, and users stay on the previous revision. Rolling back is `gcloud run services update-traffic gomax-api --to-revisions=<previous>=100`.

**Environments:** staging and prod each have their own GCP project, Supabase project and Terraform state. Prod settings: `min_instances = 2`, `redis_tier = STANDARD_HA`, `api_domain = api.gomax.app` (load balancer + Cloud Armor), `alert_email` set.

**Rough monthly cost (prod):**
- Supabase Pro + compute add-on: about $25–60
- Cloud Run with 2 always-on instances: about $40–70
- Memorystore Standard HA 1 GB: about $80
- Load balancer + Cloud Armor: about $25–30
- Storage, Scheduler, Secrets, Registry: about $5–10
- Cloud NAT + static IP (only with Razorpay): about $35–45

That totals roughly **$175–250 a month**, before WhatsApp and payout fees. These are estimates; check the GCP and Supabase pricing pages for current rates.

Setup and release steps are in [README.md](README.md).

## 14. Production checklist

**Infrastructure**
- [ ] Supabase prod project in Mumbai; PITR add-on on; a restore drill done
- [ ] `min_instances = 2`, `redis_tier = STANDARD_HA`, `api_domain` set and its DNS pointed at the `api_ip` output
- [ ] `max_instances × db_pool_per_instance` is under the Supabase pooler limit
- [ ] Alerts are reaching `alert_email`

**Security**
- [ ] All manual secrets filled in: Supabase URLs + CA certificate, WhatsApp token + app secret
- [ ] `/readyz` returns `"db":"fulfilled","redis":"fulfilled"`
- [ ] The Supabase REST API returns nothing for `gomax` tables, tested with the anon key
- [ ] The `*.run.app` URL refuses requests once the domain is live
- [ ] The first owner login is created with a strong password; other staff logins have their roles set
- [ ] A WhatsApp webhook with a bad signature gets 403
- [ ] With Razorpay on: the three Razorpay secrets are filled, `egress_ip` is whitelisted in RazorpayX, the webhook is added for `payout.*` events, and a ₹1 test payout to a staff UPI comes back Paid with a UTR

**Performance**
- [ ] k6 load test at 2× the expected peak on login, home, scan and ledger
- [ ] `EXPLAIN ANALYZE` on the scan transaction and ledger queries using prod-like data

**Product**
- [ ] Client values entered in Admin → Settings: spin odds, scratch prizes, streak rewards, limits, ranks
- [ ] Real gift list and prices, product TDS PDFs, and the first coupon batch moved to "In market"

## 15. Not built yet / open questions

- **Next:**
  - connect the app (replace the bodies of `mobile-app/src/v3/api/*`; tokens in SecureStore);
  - the Admin website (`admin-web/`) is built on this API; still not built: second-owner sign-off on money settings, admin alerts, Hindi/Punjabi names for products and challenges, a games-stats view, dealer sign-in (phase 2).
- **Waiting on the client:**
  - RazorpayX keys, account number and webhook secret (the code is ready; §7b);
  - a PAN verification provider (UPI name check can use RazorpayX);
  - WhatsApp Business number and templates;
  - area codes for dealer Login IDs, and the area list for batches / dashboard filters;
  - final T&C text (3 languages);
  - second-owner sign-off on money settings.
- **To confirm with the client:**
  - Referral levels 2–4: is each 10% of the original scan (as built), or 10% of the level below?
  - Spins: 3/4/5 by rank (as built) vs "1 free spin a day" (D7).
  - Coupon code format: 8 characters (as built). The mock-ups show `GMX-1234-5678`; the scanner accepts both.
  - Does a fifth rank, "GoMax Star", exist (it appears in the design system)?
  - GoMax Legend limit and benefits; final spin odds, scratch prizes, streak rewards and gift prices.
