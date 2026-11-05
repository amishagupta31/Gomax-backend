# Load tests (k6)

These check that the API stays fast and correct under launch-day traffic. **Run them only against staging**, never prod.

```
load/
├── seed.ts      creates load-test users + an in-market coupon batch, writes data/codes.json
├── k6/gomax.js  the scenarios
└── data/        generated (git-ignored)
```

## One-time setup on staging

1. Install k6: https://grafana.com/docs/k6/latest/set-up/install-k6/
2. Give staging a load-test key, so the API's per-IP limiter lets one load machine act as thousands of phones:
   ```bash
   echo -n "$(openssl rand -hex 24)" | gcloud secrets create gomax-loadtest-key --data-file=-
   # add LOADTEST_KEY (from that secret) to the staging Cloud Run service; APP_ENV must be "staging".
   ```
   The API refuses to start if `LOADTEST_KEY` is set and `APP_ENV=prod`. Staging has no Cloud Armor (`api_domain` empty), so the edge doesn't throttle either.
3. Seed users and codes into the staging database. Use the session pooler URL; the load users have WhatsApp switched off:
   ```bash
   DATABASE_URL="<staging session pooler URL>" DB_CA_CERT_FILE=prod-ca-2021.crt \
     npx tsx load/seed.ts --users 20000 --codes 300000
   ```
   Each fresh coupon can be added only once. Give every run its own `CODE_OFFSET`, or re-seed, so earlier runs' scans don't show up as "already used".

## Scenarios

```bash
k6 run -e BASE_URL=https://<staging url> -e LOADTEST_KEY=<key> -e USERS=20000 -e SCENARIO=<name> [options] load/k6/gomax.js
```

| `SCENARIO` | What it simulates | Main options |
|---|---|---|
| `smoke` | 5 users for 1 min; checks the script and the environment | — |
| `peak` | Launch day: up to `PEAK_VUS` people using the app at once, each with 5–20 s between taps. 55% scan (5% rescan an old code, 2% type a wrong one), 15% history, 10% spin, 10% notifications, 10% challenges + scratch cards | `PEAK_VUS` (2000), `RAMP` (10m), `HOLD` (20m), `CODE_OFFSET` |
| `scan_rush` | Morning rush when packs are opened: a fixed number of scans per second | `SCAN_RATE` (200), `DURATION` (10m), `CODE_OFFSET` |
| `login_storm` | Everyone opens the app after an update and logs in | `LOGIN_RATE` (150/s), `HOLD` (2m) |
| `midnight_spins` | Spins reset at 12 am; `SPIN_USERS` people spin within seconds | `SPIN_USERS` (1000), `SPIN_RATE` (300/s), `SPIN_FOR` (10s) |
| `soak` | `SOAK_VUS` people for an hour; catches leaks and connection-pool exhaustion | `SOAK_VUS` (500), `DURATION` (60m) |

Every scenario except `login_storm` logs its users in during k6's `setup()`, before the clock starts. Real users are already signed in, because the app keeps a 90-day refresh token. Login cost is measured on its own in `login_storm`.

## Pass / fail gates (the run fails if any is missed)

| Gate | Limit |
|---|---|
| Server errors (5xx) | < 0.5% |
| A fresh coupon not added | 0 |
| Home | p95 < 400 ms, p99 < 900 ms |
| Scan | p95 < 600 ms, p99 < 1.2 s |
| History (ledger) | p95 < 400 ms |
| Spin | p95 < 500 ms |
| Login (login_storm) | p95 < 1.5 s |

Business answers such as "already used", "no spins left" or a wrong code are correct responses, not errors.

## What to watch on staging while it runs

- Cloud Run: instance count, CPU, request latency.
- Supabase: CPU, active connections. Pooler clients must stay under the plan's limit, which is roughly `max_instances × db_pool_per_instance`.
- Memorystore: connected clients, memory.
- After the run, the money invariants must hold: every balance equals its ledger, and no coupon is added twice. Run `test/invariants.ts`' queries against staging, or check the admin dashboard.

## Results from a local dry run (21–23 Oct 2026)

Everything ran on one Windows laptop (12 cores): k6, **one** API instance (the production build, 20 DB connections) and Postgres 16. Node uses one core per instance, so "one instance" here is close to one Cloud Run vCPU. Treat these as planning numbers and confirm them on staging.

| Scenario | Load | Result |
|---|---|---|
| smoke | 5 users, 1 min | All gates pass; 0 errors |
| scan_rush | 150 scans/s for 1 min (9,000 scans) | scan p50 11.5 ms · p95 15 ms · p99 97 ms; 0 server errors |
| login_storm | 40 logins/s | login p95 34 ms; 0 errors |
| login_storm | 100 logins/s | One instance tops out near **65 logins/s** (argon2 is deliberately slow); above that logins queue (p95 7.6 s) but **none fail** |
| midnight_spins | 1,000 people × 3 spins at 300/s | spin p95 7.2 ms; 0 errors; exactly 3 spins each |
| peak, before optimising Home | 1,000 users (≈110 req/s) | Instance CPU-bound: Home p95 3.5 s, scan p95 1.2 s; 0 errors |
| **peak, after optimising Home** | 1,000 users (≈110 req/s) | **All gates pass**: Home p95 121 ms · history 116 ms · scan 294 ms · spin 146 ms; 0 errors in 18,654 requests |
| peak, after | 2,000 users (offers ≈220 req/s) | Above one instance's ceiling of **≈140 req/s**: requests queue (p95 3.5–5 s) but **0 errors, 0 wrong answers** |

In every run, every fresh coupon was added exactly once and no request failed with a server error, even past the instance's ceiling. The money checks in `test/invariants.ts` also pass under 240 parallel scans on real Postgres.

### What this means for launch

- **Capacity per instance:** about 140 requests/s for the real app mix, so plan on about 120 to keep headroom.
- **20,000 people in the app at once** (5–20 s between taps) ≈ 1,700 requests/s ≈ **15 instances**. `prod.tfvars.example` now sets `max_instances = 30` for margin. That means up to 30 × 5 = 150 Supabase pooler connections; pick a Supabase compute size that allows it.
- **Login storms** cost the most CPU. The app should refresh tokens rather than log in again. On a big release day, raise `min_instances` for the morning.
- **The fix the test found:** Home was making ~13 database round trips; it now makes 5 (shared user row, one combined counter query, cached challenge list, only the shown challenge computed). That made Home **~30× faster at the same load**.

### Pitfalls seen while running
- Use `127.0.0.1`, not `localhost`, on Windows: `localhost` tries IPv6 first and adds about 200 ms to every new connection.
- 1,000 connections opening in the same millisecond were refused by the Windows TCP stack, not the API. On Cloud Run, phones connect to Google's front end, and the server asks for a 1,024-deep accept queue.
- Don't let the machine sleep during a run: requests in flight time out on resume and show up as errors.
- Every fresh coupon can be added once: re-seed or use a new `CODE_OFFSET` for every run.
