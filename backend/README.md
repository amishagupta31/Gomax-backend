# GoMax API (GCP)

Backend for the v3 Applicator app (`mobile-app/src/v3`) and the GoMax Admin website. The API runs on **Cloud Run** (GCP, Mumbai) and the database is **Supabase Postgres**. The architecture and its reasons are in [ARCHITECTURE.md](ARCHITECTURE.md).

```
backend/
├── src/
│   ├── main.ts            Cloud Run entry (Supabase Postgres + Memorystore Redis)
│   ├── dev.ts             zero-setup local API (embedded Postgres in ./.data)
│   ├── app.ts             Fastify app: security headers, CORS, rate limits, errors
│   ├── config.ts          env vars (validated at start-up)
│   ├── db/                schema.ts · migrations/ · migrate.ts · seed.ts
│   ├── lib/               ledger, settings, time (IST), codes, crypto, JWT, storage, WhatsApp, KYC
│   ├── services/          scan rewards, referrals, streak, challenges, fraud rules
│   └── modules/           routes: app (/v1/…) and admin (/v1/admin/…), webhooks, jobs
├── test/                  API tests on an in-memory Postgres (PGlite)
├── infra/terraform/       GCP: Cloud Run, Redis, Storage, Secrets, Scheduler, LB + Cloud Armor, alerts, IAM
├── cloudbuild.yaml        test → image → migrate → deploy
└── Dockerfile
```

## Run it locally

No database install needed:

```bash
cd backend
npm install
npm run dev:local        # http://localhost:8080
```

- **Demo applicator:** 98765 43210 / `gomax123`.
- **Demo admin:** `owner` / `owner-pass-123` / PIN `1234`.
- **Coupon codes:** a few demo codes are printed in the console at start.
- **WhatsApp:** messages are printed to the console instead of being sent.

To run against your own Postgres instead, copy `.env.example` to `.env` and run `npm run build && npm run migrate && npm run seed && npm start`.

## Tests

```bash
npm test          # 131 API tests, about 1 min, no database needed
# Same tests on a real Postgres (needed for the high-traffic race tests):
#   TEST_DATABASE_URL=postgres://user@host:5432/postgres npm test
# Full test-case catalogue: test/TEST_CASES.md · load tests: load/README.md
npm run typecheck
```

The tests cover:
- login pause after 3 wrong tries, refresh-token rotation, and the WhatsApp password reset
- coupon rules: wrong, not active, expired, blocked, already used, and two people scanning at once
- the first-coupon bonus, the 10th-coupon scratch card, and offline scans
- fraud holds
- withdrawals: limits, PIN approval, unique UTR, refunds, and staff roles
- gift booking, stock and courier steps
- spins, including that 100 can never be drawn
- challenges, quests, streak rules and referral levels with the monthly cap
- jobs, the append-only audit log, row-level security on every table, cursor pagination and `/readyz`

## Deploy

You need `gcloud` and `terraform` installed. Each environment (staging, prod) gets its own GCP project (billing on) and its own Supabase project in **Mumbai (ap-south-1)**.

```bash
# 1. Sign in
gcloud auth login && gcloud auth application-default login
gcloud config set project gomax-staging

# 2. One-time: a bucket for Terraform state
gcloud storage buckets create gs://gomax-staging-tfstate --location=asia-south1 --uniform-bucket-level-access

# 3. Create the infrastructure
cd backend/infra/terraform
cp prod.tfvars.example staging.tfvars   # edit: project_id, env = "staging", min_instances = 0, redis_tier = "BASIC", api_domain = ""
terraform init -backend-config="bucket=gomax-staging-tfstate"
terraform apply -var-file=staging.tfvars

# 4. Paste the Supabase connection details (Supabase → Connect, and Database settings → SSL)
echo -n "postgresql://postgres.<ref>:<pw>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres" | gcloud secrets versions add gomax-database-url --data-file=-
echo -n "postgresql://postgres.<ref>:<pw>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres" | gcloud secrets versions add gomax-direct-url --data-file=-
gcloud secrets versions add gomax-db-ca-cert --data-file=prod-ca-2021.crt

# 5. Release (and every release after): tests → image → migrate → 0%-traffic deploy → traffic shift
cd ../..                                # backend/
gcloud builds submit --config cloudbuild.yaml --substitutions=_ENV=staging .

# 6. One time: catalogue + first owner login
gcloud run jobs execute gomax-migrate --region asia-south1 --wait   --args=dist/db/seed.js   --update-env-vars=SEED_OWNER_LOGIN=sharad,SEED_OWNER_PASSWORD='<strong password>',SEED_OWNER_PIN='<4 digits>'
```

`terraform output` shows `api_url`, which goes in the app as `EXPO_PUBLIC_API_URL`, and the WhatsApp webhook URL for Meta.

To put Cloud Armor in front (prod), set `api_domain = "api.gomax.app"` and run `terraform apply`. Point the domain's A record at the `api_ip` output; Google issues the certificate within about 30 minutes. After that, the `*.run.app` URL stops answering.

For automatic releases, connect the repository in Cloud Build and add a trigger on `main` that uses `backend/cloudbuild.yaml`.

**Turning on WhatsApp**, once the Business number and templates are approved:

```bash
echo -n "<permanent token>" | gcloud secrets versions add gomax-wa-token --data-file=-
echo -n "<app secret>"      | gcloud secrets versions add gomax-wa-app-secret --data-file=-
# then in the tfvars: whatsapp_driver = "meta", wa_phone_number_id = "<id>"  → terraform apply
```

Template names and their `{{1}}…` order are in `src/lib/whatsapp.ts` (`PARAMS`).

**Turning on Razorpay** (automatic payouts and the UPI name check; details in [ARCHITECTURE.md §7b](ARCHITECTURE.md#7b-payouts-razorpayx)):

1. In the Razorpay Dashboard, generate API keys (test keys first: `rzp_test_…`).
2. Save the keys as secrets:
   ```bash
   echo -n "<key id>"     | gcloud secrets versions add gomax-razorpay-key-id --data-file=-
   echo -n "<key secret>" | gcloud secrets versions add gomax-razorpay-key-secret --data-file=-
   ```
3. In RazorpayX → Settings → Webhooks, add `terraform output razorpay_webhook_url`, choose the `payout.*` events, type a secret, and save that secret too:
   ```bash
   echo -n "<webhook secret>" | gcloud secrets versions add gomax-razorpay-webhook-secret --data-file=-
   ```
4. In the tfvars, set `payout_mode = "razorpayx"`, `kyc_driver = "razorpay"` and `razorpayx_account_number = "<account no>"`, then run `terraform apply`.
5. Whitelist `terraform output egress_ip` in RazorpayX → Settings → Developer Controls → IP whitelist.
6. Send one small withdrawal to a staff UPI and check that it shows Paid with a UTR.

**Testing payouts by hand on your laptop.** With no keys, `PAYOUT_MODE=razorpayx npm run dev:local` uses a local stand-in for RazorpayX. Approve a withdrawal, then send it with `curl -X POST localhost:8080/internal/jobs/payouts -H "x-jobs-secret: dev-jobs"`. The server prints the payout id; play Razorpay's answer with:

```bash
npm run rzp:webhook -- pout_dev000001 processed            # → Paid with a random UTR
npm run rzp:webhook -- pout_dev000001 failed "Bank down"   # → Failed, points back
BAD_SIGNATURE=1 npm run rzp:webhook -- pout_dev000001 processed   # → 403
```

With test keys (`rzp_test_…`) in `.env`, the same steps go to RazorpayX test mode. For Razorpay's own webhooks to reach your laptop, use a tunnel such as `ngrok http 8080` and add its URL + `/webhooks/razorpay` in the RazorpayX test dashboard.

## API at a glance

All app routes are under `/v1` and need `Authorization: Bearer <accessToken>`, except the `/auth/*` routes. Access tokens last 15 minutes; renew them with `POST /v1/auth/refresh`, which also replaces the refresh token. Errors always look like `{ "error": { "code": "…", "message": "…" } }`. `message` is plain text you can show on screen, and `code` is what the app should branch on. Lists return `nextCursor`; pass it back as `?cursor=` to get the next page. The full reference is in [ARCHITECTURE.md §7](ARCHITECTURE.md#7-api).

| App screen | Endpoint |
|---|---|
| A1 Login / sign up / forgot | `POST /auth/login` · `POST /auth/signup` · `GET /auth/referral/:code` · `GET /auth/registered?mobile` · `POST /auth/reset-request` · `POST /auth/reset-password` |
| A2/A3 Home, PAN/UPI | `GET /home` · `GET /me` · `PATCH /me` · `GET /me/rank` · `POST /me/kyc/pan` · `POST /me/kyc/upi/check` · `PUT /me/kyc/upi` |
| B1 Scan, My scans | `POST /coupons/redeem` · `GET /me/scans?range&status` |
| B2/B4 Wallet, gifts, history | `GET /wallet` · `GET /ledger?wallet&kind&range` · `GET /gifts` · `POST /gift-orders` · `GET /gift-orders[/:id]` |
| B3 Withdraw | `POST /withdrawals` · `GET /withdrawals[/:id]` · `POST /uploads` (UPI QR) |
| C1 Products | `GET /products` · `GET /products/:id` · `GET /products/:id/tds` |
| C2 Games | `GET /spins/today` · `POST /spins` · `GET /scratch-cards` · `POST /scratch-cards/:id/reveal` · `GET /challenges[/:id]` · `POST /challenges/:id/claim` · `GET /quests` · `GET /streak` · `POST /uploads` + `POST /streak/photo` · `GET /games/history` |
| C3 Invite | `GET /me/referrals` |
| C4 Notifications | `GET /notifications?kind` · `POST /notifications/read` |

**Admin website (`/v1/admin`)**:
- **Login and dashboard:** `auth/login` (email + password) · `dashboard` · `dashboard/insights`
- **Coupons:** `coupon-batches` (create, status, print PDF, CSV export) · `coupons/:code` (lookup, block) · `scans` · `fraud-flags`
- **Money:** `withdrawals` (approve with PIN, hold, reject, lock, mark-paid, send-back, fail)
- **Gifts:** `gifts` · `gift-orders` (pack, ship, deliver, cancel)
- **People:** `applicators` (KYC filters, profile, PAN, tree, hold, block, adjust, reset password, unlock, Mark KYC ok) · `helpline-requests` · `referrals/top`
- **Dealers:** `dealers` (create login, reset password, deactivate, reactivate)
- **Games:** `challenges` · `streak-photos`
- **Content and system:** `content` (Home cards, How GoMax works, T&C) · `products` · `settings/:key` · `audit` · `staff` · `uploads`

## Things the client still has to confirm

These are listed in [ARCHITECTURE.md §15](ARCHITECTURE.md#15-not-built-yet--open-questions). Every value below can be changed in Admin → Settings without a code change, so the client's answers don't need a new release:
- spin odds
- scratch prizes
- streak rewards
- referral cap and share
- withdraw limits
- fraud limits
- rank thresholds and benefits
