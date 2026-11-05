# GoMax Admin website

The office website at admin.gomax.in, built from Figma “GOMAX – DEV”, page **03 · Admin (For applicator)**: desktop pages D0–D11, and the phone layout M0–M7 under 600 px wide. It uses the same API as the app (`../backend`, routes under `/v1/admin`). It's a separate frontend: React 19 + Vite + TypeScript, plain CSS tokens in `src/styles.css`, and Lucide icons.

## Run locally

```bash
cd ../backend && npm run dev:local   # API on :8080 with demo data
cd ../admin-web && npm install && npm run dev   # http://localhost:5174
```

With `npm run dev:local`, log in as `owner` / `owner-pass-123` (PIN `1234` for money approvals). The dev server forwards `/v1` to the API, so CORS isn't involved locally.

## Build and deploy

The site deploys on its own to Cloud Run: an nginx container serving the built files (`Dockerfile`, `nginx.conf`), using the same `gomax` image registry as the API.

```bash
# from the repo root
gcloud builds submit --config admin-web/cloudbuild.yaml   --substitutions=_ENV=prod,_API_URL=https://api.gomax.app admin-web
```

- `_API_URL` is the API's public URL. It's baked into the build (`VITE_API_URL`).
- **Allowed origins:** the API must list the site's address in `CORS_ORIGINS`. Prod tfvars already contain `https://admin.gomax.in`; add the `*.run.app` URL there too if you test with it.
- **Domain:** to serve on `admin.gomax.in`, map the domain to the `gomax-admin` Cloud Run service (Cloud Run → Manage custom domains), or put it behind the load balancer.
- **Other hosts:** any static host works too. Run `npm run build` and upload `dist/`; every path must fall back to `index.html`.

## Sign-in

- **Login:** email + password.
- **PIN again:** asked again before approving money.
- **Tokens:**
  - The access token is kept in memory.
  - The refresh token (1 day) is kept in `localStorage`.
  - Refreshes are coordinated across tabs (Web Locks), so several open tabs don't log each other out.

## Pages → design → API

| Page | Figma | API |
|---|---|---|
| Login | M1 madm-login | `auth/login`, `refresh`, `me`, `logout` |
| Dashboard (owner / factory / phone) | D1, D1b, M1 | `dashboard`, `dashboard/insights`, `fraud-flags`, `coupon-batches`, `gift-orders` |
| Applicators + profile | D9b, M5 | `applicators?view=`, `applicators/:id`, `/pan`, `/tree`, `/hold`, `/block`, `/adjust`, `/reset-password`, `/unlock`, `/kyc-ok`, `helpline-requests` |
| Coupons + create batch | D2a–d, M3 | `coupon-batches` (create, status, `print.pdf`, CSV export) |
| Scans log: lookup, all scans, flags, dispute | D3a–d, M3 | `coupons/:code`, `coupons/:code/block`, `scans`, `fraud-flags`, `fraud-flags/:id/decide` |
| Withdrawals: queue, review, manual UPI pay | D4a, D4c, D11a–c, M2, M7 | `withdrawals` + `approve` / `hold` / `reject` / `lock` / `mark-paid` / `send-back` / `fail`, `uploads` |
| Gifts & courier | D5a–c, M4 | `gifts`, `gift-orders` + `pack` / `ship` / `deliver` / `cancel`, `uploads` |
| Referral tree | D6a–b, M5 | `referrals/top`, `applicators/:id/tree`, `settings` |
| Games & odds | D7a–b | `settings/spinOdds`, `settings/scratch` |
| Challenges + photo review | D7c–e | `challenges`, `streak-photos`, `settings/streak` |
| Products & TDS | D9a | `products`, `products/:id`, `uploads` (PDF) |
| Settings, ranks, staff logins | D9c, D9c2 | `settings/:key`, `staff` |
| Audit log | D9d | `audit`, `staff` |
| Phone: Approvals, Coupons, Me, Key rules, Desktop tools | M2, M3, M5, M6 | as above |
| Dealers | D10 | `dealers` (create, `reset-password`, `deactivate`, `reactivate`) |
| Home content | D8a | `content`, `content/cards`, `content/pages/:key` (the app reads `/v1/content`) |
| WhatsApp messages | D8b | Lists the real templates; editing them happens in Meta Business Manager |

Anything the design shows but the API doesn't provide is marked on the page with a yellow **“Not connected yet”** note. Nothing on these pages is invented.
