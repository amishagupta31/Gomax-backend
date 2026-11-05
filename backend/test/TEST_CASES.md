# GoMax backend — test cases

Every case below is either **automated** (the file is named in the "Covered by" column) or **manual** (marked 📱, to be checked on a real phone or in the admin website). Load and capacity tests are in [../load/README.md](../load/README.md).

## How to run

| What | Command | Notes |
|---|---|---|
| All automated tests | `npm test` | In-memory Postgres; about 30 s; no setup |
| Same tests on a real Postgres | `TEST_DATABASE_URL=postgres://user@host:5432/postgres npm test` | Each test file gets a fresh database, dropped afterwards. **Use this for the concurrency tests**: only a real server runs requests truly in parallel |
| Load tests | see [../load/README.md](../load/README.md) | Staging only |

After every concurrency and journey test, `invariants.ts` checks that the money still adds up:
- every balance equals its ledger;
- no balance is negative;
- each ledger row's running balance follows the one before;
- no coupon was added twice;
- every withdrawal and gift order has exactly one debit, and refunds match;
- gift stock never goes below zero, and no UTR is used twice.

Files: `auth.test.ts` (A) · `auth-security.test.ts` (AS) · `otp.test.ts` (O) · `razorpay.test.ts` (R) · `scan.test.ts` (S) · `money.test.ts` (M) · `games.test.ts` (G) · `concurrency.test.ts` (C) · `journeys.test.ts` (J) · `extra.test.ts` (X) · `admin-gaps.test.ts` (AG).

---

## 1. Sign-up, login, password (A1)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| AUTH-01 | Sign up with name, mobile `98765 43210`, password | Account created; mobile saved as 10 digits; invite code like `RAM245`; welcome WhatsApp queued | A |
| AUTH-02 | Sign up again with the same mobile | 409 `mobile_taken` | A |
| AUTH-03 | Password without a number / under 8 characters | 400 `invalid_input` | A |
| AUTH-04 | Login with `+91 98765 43210` format | Accepted (number normalised) | A |
| AUTH-05 | Login with an unregistered number | 404 `not_registered` | A |
| AUTH-06 | 1st and 2nd wrong password | 401 `wrong_password`, `triesLeft` 2 then 1 | A |
| AUTH-07 | 3rd wrong password | 423 `paused` with `until` = +30 min; even the right password is refused while paused | A |
| AUTH-08 | 31 minutes later, right password | 200 | A |
| AUTH-09 | Refresh token used | New pair; the old refresh token no longer works | A |
| AUTH-10 | Logout, then use that refresh token | 401 | A |
| AUTH-11 | Referral code typed in any case (`ram245`) | Shows the inviter's name | A |
| AUTH-12 | Unknown referral code at sign-up | 400 `bad_referral` | A |
| AUTH-13 | WhatsApp `RESET <number>` sent from a different number | Ignored; no link sent | A |
| AUTH-14 | WhatsApp `reset 98765 43210` from the owner's number | One-time link sent on WhatsApp | A, J |
| AUTH-15 | Reset link used twice | 2nd time 400 `link_expired` | A |
| AUTH-16 | Reset link used after 15 min | 400 `link_expired` | J |
| AUTH-17 | After a reset | Old sessions signed out; new password works | A, J |
| AUTH-18 | Helpline "call me back" request | Recorded; same answer whether or not the number exists | X |
| AUTH-19 | App request without a token / with a staff token | 401 | A |
| AUTH-20 | Blocked account | App calls 403, refresh 401, login 403 `blocked`; works again after unblock | J |

### Sign-up SMS OTP (Firebase Phone Auth)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| OTP-01 | Valid OTP token for the same number | Account created; `phone_verified_at` and `firebase_uid` saved; later logins need no OTP | O |
| OTP-02 | No OTP token | 400 `otp_required` | O |
| OTP-03 | OTP done on one number, sign-up with another | 400 `otp_mobile_mismatch` | O |
| OTP-04 | Token not signed by Google / other project / other issuer / expired / OTP older than 10 min | 401 `otp_invalid` | O |
| OTP-05 | Firebase sign-in that wasn't a phone OTP (e.g. Google account) | 401 | O |
| OTP-06 | Non-Indian number | 401 | O |
| OTP-07 | Number edited inside the token | 401 | O |
| OTP-08 | Valid token for a number that already has an account | 409 `mobile_taken` | O |
| 📱 OTP-M1 | Real SMS on Jio / Airtel / Vi; auto-read on Android; resend after 30 s; wrong code | OTP arrives within ~30 s; wrong code shows an error without calling our API | Manual |

## 2. Scanning coupons (B1)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| SCAN-01 | First valid coupon ever | `added`, value from the batch + 25 bonus; ledger shows "Coupon scan" and "Bonus: first scan" | S, J |
| SCAN-02 | Code typed as `GMX-ABCD 2345`, lower case, with spaces | Accepted (normalised) | S |
| SCAN-03 | QR payload is a URL `https://gomax.in/c/ABCD2345` | Accepted | S |
| SCAN-04 | Same code scanned again by the same person | `used`, `byYou: true` | S |
| SCAN-05 | Code already used by someone else | `used`, `byYou: false`; the second person gets a fraud flag and cash hold | S |
| SCAN-06 | Random text / wrong code | `invalid`; the try is logged | S |
| SCAN-07 | Code from a batch not yet "In market" | `not_active` | S |
| SCAN-08 | Code from an expired batch | `expired` | S |
| SCAN-09 | Code blocked by an owner (lost / stolen) | `blocked` | S |
| SCAN-10 | 10th coupon of the day | Reward = one scratch card; 11th coupon gives no second card | S, C |
| SCAN-11 | Offline scan sent within 7 days | Counted on the day it was scanned, not today | S, J |
| SCAN-12 | Offline scan older than 7 days | 400 `bad_time` | J |
| SCAN-13 | My scans: Today / Week / Month, Added / Failed filters | Correct rows and totals; newest first | S |
| SCAN-14 | My scans paging (`limit=3`, `cursor`) | Every scan exactly once across pages; last page `nextCursor: null` | S |
| SCAN-15 | More than 15 scans in 5 min | `scan_burst` flag, cash on hold | S |
| SCAN-16 | Scan crosses 500 lifetime points | `rankUp: "Kaarigar"`, notification + WhatsApp, spins become 4 | G, J |
| SCAN-17 | Runs from the scan quest make a gift affordable | `reward: { kind: "gift" }` | X |
| 📱 SCAN-M1 | Scan a real printed QR in daylight, low light, at an angle, slightly torn | Reads within ~1 s; torch button helps in the dark | Manual |
| 📱 SCAN-M2 | Camera permission denied, then allowed in Settings | B1-00a/00b screens; manual code entry still works | Manual |
| 📱 SCAN-M3 | Phone in airplane mode, scan 3 coupons, then reconnect | Saved offline (B1-06), sent later with the original time; points arrive | Manual |
| 📱 SCAN-M4 | Kill the app right after tapping scan | Either added or not — never added twice; My scans shows the truth | Manual |

## 3. Wallet, history, withdraw (B2–B4)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| WD-01 | Withdraw without PAN / UPI | 400 `kyc_missing` | M |
| WD-02 | UPI saved before PAN | 400 `pan_first` | M |
| WD-03 | UPI name doesn't match PAN | 400 `name_mismatch` | X |
| WD-04 | Withdraw 499 / 5,001 | 400 `below_min` / `above_max` | M |
| WD-05 | Withdraw 1,000 | `requested`; points drop at once | M, J |
| WD-06 | Over ₹15,000 in one IST month | 400 `month_limit` with `leftThisMonth` | M, J |
| WD-07 | New month (1st, 12:05 am IST) | Limit available again | J |
| WD-08 | Account on hold | 409 `under_check` | J |
| WD-09 | Staff approves with a wrong PIN | 403 "Wrong PIN" | M |
| WD-10 | Mark paid before approval | 409 `bad_status` | M |
| WD-11 | Mark paid without uploading proof | 400 `proof_missing` | M |
| WD-12 | Approve → lock → mark paid with UTR + proof | `paid`; user sees UTR + proof link; WhatsApp `withdrawal_paid` with UTR spaced `4271 8836 5520` | M, J |
| WD-13 | Same UTR on a second payout | 409 `utr_used` | M, C |
| WD-14 | Reject with reason | Points returned; user sees the reason; WhatsApp sent | M |
| WD-15 | Payment failed (wrong UPI) | Points returned; status `failed`; WhatsApp sent | M |
| WD-16 | Audit trail of a payout | `withdrawal_approve` then `withdrawal_paid` rows with staff + time | M |
| WD-17 | History: points / runs, kind chips, date ranges, totals, paging | Correct rows; earned/spent totals match | S, M |
| WD-18 | Owner lowers the minimum to 300 in Settings | Applies at once; old/new value in the audit log | J |

### Payouts through RazorpayX (`PAYOUT_MODE=razorpayx`)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| RZP-01 | Approve → payouts job | One payout: amount in paise, UPI fund account, `reference_id W-<id>`, idempotency key `gomax-W-<id>`; re-running the job sends nothing more | R |
| RZP-02 | Webhook `payout.processed` | Paid with the bank UTR; notification + WhatsApp `withdrawal_paid` (UTR spaced); a repeat webhook changes nothing | R |
| RZP-03 | Webhook with a wrong or missing signature | 403; withdrawal unchanged | R |
| RZP-04 | Webhook `failed` / `rejected` (sent twice) | Failed with the bank's reason; points returned once | R |
| RZP-05 | `reversed` after Paid | Failed; points returned | R |
| RZP-06 | RazorpayX down (503) while sending | Stays approved; staff see `payoutStatus: error` + message; next run sends exactly one payout | R |
| RZP-07 | RazorpayX created the payout but the reply was lost | Retry with the same key gets the same payout; never a second one | R |
| RZP-08 | Webhook never arrives | After 30 min the job asks RazorpayX and marks it Paid with UTR | R |
| RZP-09 | Staff try lock / mark-paid / reject / send-back / fail on a RazorpayX payout | 409 `auto_payout` / `sent_to_razorpay` | R |
| RZP-10 | Same person withdraws again | Same RazorpayX contact and fund account reused | R |
| RZP-11 | Every RazorpayX call | Basic auth with the key id | R |
| RZP-12 | Razorpay switched on without keys / webhook secret | Server refuses to start, listing what's missing | R |
| RZP-13 | UPI name check through RazorpayX | Registered name returned; closed UPI and bad format refused | R |
| 📱 RZP-M1 | Live ₹1 payout to a staff UPI with test, then live keys | Paid with a real UTR within minutes; webhook arrives from Razorpay | Manual |

## 4. Gifts (B2, D5)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| GIFT-01 | Order without enough runs | 409 `insufficient_balance` | M |
| GIFT-02 | T-shirt without a size | 400 `size_required` | M, J |
| GIFT-03 | Order a gift | `booked`; runs taken at once | M, J |
| GIFT-04 | Factory: pack → ship (courier, AWB, ETA) → deliver (photo + who received) | Each step shows in the app with dates; WhatsApp at each step | M, J |
| GIFT-05 | Booked for over 2 days | Marked late (`stale`) on the board | J |
| GIFT-06 | Owner cancels | Runs and stock returned | M |
| GIFT-07 | Last items in stock | Never oversold; `out_of_stock` after | M, C |
| GIFT-08 | Factory staff open withdrawals | 403 | M, J |

## 5. Games (C2)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| GAME-01 | Spins by rank | Naya Saathi 3, Kaarigar 4, Ustaad 5 a day | G, J |
| GAME-02 | Spin after using them all | 409 `no_spins_left` with seconds to reset | G |
| GAME-03 | 12:01 am IST | Spins, today's coupons and quests reset | G, J |
| GAME-04 | Prize is never 100 | Even if an owner tries, Settings rejects 100 | G |
| GAME-05 | Scratch card hidden until revealed; reveal twice | Same prize, credited once | S |
| GAME-06 | Card not opened in 7 days | `expired` | S |
| GAME-07 | Weekly challenge progress and milestones | 12/20 shows milestones 5 and 10 reached | G |
| GAME-08 | Claim before complete / twice | 409 `not_complete` / `already_claimed` | G |
| GAME-09 | Ultra challenge | Counts only coupons from Ultra batches | G |
| GAME-10 | Daily quests | Paid once a day; the invite quest is the +50 referral (not paid twice) | G |
| GAME-11 | Photo streak: one photo a day | 2nd photo same day 409 `already_today` | G |
| GAME-12 | Missed day | Streak back to 0 | G |
| GAME-13 | Office rejects a photo | That day stops counting; WhatsApp with reason | G |
| GAME-14 | Photo older than 15 min / someone else's upload | 409 `photo_too_old` / 403 | G |
| GAME-15 | 15-day streak | +50 runs once | G |
| GAME-16 | Games history | Spin, scratch, challenge rows with totals | S |

## 6. Invite & referrals (C3, D6)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| REF-01 | Friend's first coupon | Inviter +50 runs, notification + WhatsApp `friend_joined` | G, J |
| REF-02 | Every scan by people below | Each level L1–L4 earns 10% of the points, in runs | G, J |
| REF-03 | Monthly cap | All referral runs together stop at 200 a month | G |
| REF-04 | Inviter and friend on the same phone | No referral runs | G |
| REF-05 | App shows | "X joined, Y scanning, Z runs" — no levels | G, J |
| REF-06 | Admin referral tree | L1–L4 lists with runs earned from each person | G |

## 7. Admin website (D1–D11, M1–M7)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| ADM-01 | Staff login with email + password | Tokens; login written to the audit log | M, J |
| ADM-02 | 5 wrong tries | Locked 30 min; owner can unlock | J |
| ADM-03 | Roles | Factory can't touch money or create batches; helpline can look up but not block; accounts can't change settings | M, J |
| ADM-04 | Create a batch of 500 | Codes 8 characters from the safe alphabet, all unique; ref `B-0001` | J |
| ADM-05 | Batch steps | Generated → Printed → In market; can't go backwards; only owners block | J |
| ADM-06 | CSV export | 1 header + N rows: code, admin ref, value, expiry; export audited | J |
| ADM-07 | Coupon lookup for a dispute | Who scanned it, when, where (GPS), every repeat try; helpline sees a masked mobile | J |
| ADM-08 | Dashboard | Today's counts; points liability for owners only | J |
| ADM-09 | Fraud flags | List; owner clears → hold released when no open flags remain | S, J |
| ADM-10 | Full PAN view | Accounts/owner only; stored encrypted; every view audited | X |
| ADM-11 | Goodwill adjustment | Owner only; at most 10,000; audited | M |
| ADM-12 | Products & TDS PDF | Owner replaces the PDF; the app gets a signed link | A |
| ADM-13 | Audit log | Cannot be edited or deleted, even in SQL | A |
| 📱 ADM-M1 | Admin website on a phone (M0–M7) | Approvals tab badge; "Do this on desktop" for desktop-only tools | Manual (site not built yet) |
| 📱 ADM-M2 | M7 payout on a phone | "Open UPI app" opens the company UPI app pre-filled with amount and note | Manual |

### Admin website additions (AG)

| ID | Case | Expected | Covered by |
|---|---|---|---|
| AG-01 | Dashboard insights | 14 (or 7–60) days of coupons + points, active in 30 days, registered, top applicators this month; factory 403 | AG |
| AG-02 | Applicator tabs | PAN / UPI state per row; KYC to check (PAN, no UPI), No PAN, Blocked, Cash on hold, Active filter correctly | AG |
| AG-03 | Mark KYC ok | PAN first; UPI must exist; accounts only; saved with the UPI name, audited with PAN name + note | AG |
| AG-04 | Helpline reset password / unlock | WhatsApp `password_reset` link queued; paused login (423) works again after unlock; factory 403 | AG |
| AG-05 | Helpline call-back queue | Open requests listed; mark done once (second time 404); accounts 403 | AG |
| AG-06 | Top referrers | Joined (L1), joined + scanning, runs earned, runs this month vs cap; factory 403 | AG |
| AG-07 | Create dealer login | `GMD-LDH-0001`, `-0002`…; temporary password returned once, stored hashed, expires in 7 days; search + area filter | AG |
| AG-08 | Dealer validation and roles | Bad GST / mobile / area → 400; helpline cannot create | AG |
| AG-09 | Dealer reset / deactivate / reactivate | New password hash; helpline can reset but not deactivate; inactive cannot be reset; all audited | AG |
| AG-10 | Home content | Cards in 3 languages; app gets live cards in its language with English fallback; date-range needs dates; helpline cannot edit | AG |
| AG-11 | Print PDF + batch area | `application/pdf`, 48 per A4 (50 codes = 2 pages), audited; factory yes, helpline 403; area saved | AG |
| AG-12 | Audit log for Accounts | Owners see all; Accounts only withdrawals + money actions; helpline 403 | AG |
| 📱 AG-M1 | Print a PDF page and scan 5 coupons with the app | Each QR scans as its printed code | Manual |

## 8. Security

| ID | Case | Expected | Covered by |
|---|---|---|---|
| SEC-01 | Every GoMax table | Row-level security on; Supabase public roles have no access | A |
| SEC-02 | Health checks | `/readyz` reports DB (and Redis) status | A |
| SEC-03 | Scheduled jobs without the scheduler's token | 401 | G |
| SEC-04 | WhatsApp webhook with a bad signature (when the app secret is set) | 403; a correct signature is accepted | X |
| SEC-05 | Using another user's photo upload | 403 | G |
| SEC-06 | Bad cursor value | 400 `bad_cursor` | S |
| 📱 SEC-M1 | Staging: Supabase REST API with the anon key on `gomax` tables | No data | Manual (checklist) |
| 📱 SEC-M2 | Prod: the `*.run.app` URL once the domain is live | Refused | Manual (checklist) |

## 8b. Authentication attacks

| ID | Case | Expected | Covered by |
|---|---|---|---|
| AUTHSEC-01 | User id changed inside a token | 401 (signature breaks) | AS |
| AUTHSEC-02 | Unsigned token (`alg: none`) | 401 | AS |
| AUTHSEC-03 | Token signed with another secret / from another issuer | 401 | AS |
| AUTHSEC-04 | Expired access token | 401; the app must refresh | AS |
| AUTHSEC-05 | User token edited to claim staff / owner | 401 | AS |
| AUTHSEC-06 | Garbage or 5 KB Authorization header | 401, never 500 | AS |
| AUTHSEC-07 | Refresh tokens stored | Only a SHA-256 hash in the DB | AS |
| AUTHSEC-08 | User refresh token on the staff refresh route | 401 | AS |
| AUTHSEC-09 | Refresh token after 90 days | 401 | AS |
| AUTHSEC-10 | Passwords and PINs stored | argon2id hashes only (m=19456, t=2, p=1) | AS |
| AUTHSEC-11 | Injection-looking mobile, 10,000-char password, array instead of string, broken JSON | 400, never 500 | AS |
| AUTHSEC-12 | Staff demoted or deactivated while logged in | Next request uses the new role / is refused (role read from DB, not token) | AS |
| AUTHSEC-13 | Staff login: email + password works without a PIN; wrong password | 200; 401 `wrong_login` — never says which part was wrong | AS |
| AUTHSEC-14 | Wrong PIN on a money approval, 5 times | Login locked 30 min, open sessions signed out, payout not approved | AS |
| AUTHSEC-15 | A correct PIN | Resets the wrong-PIN count | AS |
| AUTHSEC-16 | 11th login in a minute from one IP | 429 `too_many_requests` | AS + live check |
| AUTHSEC-17 | Load-test key | Skips the limiter only when set; the server refuses to start with it in prod | AS |
| AUTHSEC-18 | Another user's withdrawals / gift order by id or query param | Not visible (404 / empty) | AS |
| AUTHSEC-19 | Password hashes in any API response (app or admin) | Never | AS |
| AUTHSEC-20 | Security headers on every response | `X-Content-Type-Options`, HSTS, `X-Frame-Options`; no `X-Powered-By` | live check |

**Fixed while writing these (25 Oct 2026):** the PIN re-check before approving money had no limit, so a stolen staff session could try all 10,000 PINs. Wrong PINs now count toward the same 5-try lockout as wrong passwords, and the lockout also ends open sessions.

## 9. Many requests at the same moment

All run on real Postgres with `TEST_DATABASE_URL`, and the money invariants are checked after each.

| ID | Case | Expected | Covered by |
|---|---|---|---|
| CONC-01 | 60 applicators × 4 coupons, 240 scans in parallel | All 240 added; each user 4 coupons + one bonus | C |
| CONC-02 | 25 people scan the same code at once | Exactly 1 added, 24 used | C, S |
| CONC-03 | New user scans 6 codes at once | Welcome bonus once; inviter's +50 once | C |
| CONC-04 | 12 coupons at once | Exactly one scratch card | C |
| CONC-05 | 12 spin taps with 3 spins left | Exactly 3 spins | C |
| CONC-06 | Withdraw tapped 6 times, points for one | One request, no overdraft | C |
| CONC-07 | 5 × ₹5,000 requests together | 3 accepted (₹15,000 cap) | C |
| CONC-08 | Scratch card revealed 10 times at once | Prize credited once | C |
| CONC-09 | "Collect" pressed 6 times | Reward once | C |
| CONC-10 | Same mobile signs up 8 times at once | One account; seven clean 409 `mobile_taken` | C |
| CONC-11 | Same refresh token used twice at once | One new session | C |
| CONC-12 | 12 people order the last 3 items | Exactly 3 orders; stock 0 | C |
| CONC-13 | Two staff mark the same payout paid | One wins | C |
| CONC-14 | One UTR on two payouts at once | One accepted, other 409 `utr_used` | C |
| CONC-15 | Three outbox runs at once | No WhatsApp sent twice | C |
| CONC-16 | 40 people log in at the same moment | All succeed within 20 s | C |

**Bugs these found and fixed (22 Oct 2026):** CONC-10 and CONC-14 returned 500 instead of 409 on real Postgres. The database blocked the duplicate correctly; the API just reported it badly. Both now return the right 409, and any other unique-constraint race returns 409 `duplicate`.

## 10. Real-user journeys

| ID | Journey | Covered by |
|---|---|---|
| JOUR-01 | **Ramesh**, from sign-up to his first ₹500:<br>- joins with Suresh's code; first coupon + bonus; Suresh notified<br>- spins; first photo; 9 pm summary on WhatsApp (one message, not one per scan)<br>- 4 more days of scans and photos; becomes Kaarigar (4 spins)<br>- adds PAN + UPI; withdraws ₹500; Ankit approves with PIN and pays with UTR + proof<br>- Ramesh sees Paid with UTR and proof, and on WhatsApp; Suresh sees 1 friend scanning and his runs | J |
| JOUR-02 | **Pooja** earns runs and gets a T-shirt:<br>- 5 days of coupons, spins and photos; 5 scratch cards revealed<br>- books a T-shirt (size L); it shows as late on day 3<br>- Shivansh packs, ships with Delhivery AWB and ETA, and delivers with photo<br>- Pooja sees all 4 dates and gets WhatsApp at each step | J |
| JOUR-03 | **Fraud:** two accounts on one phone are flagged; the second account's withdrawal is refused; the owner checks (brothers) and clears it; the withdrawal goes through; the decision is in the audit log | J |
| JOUR-04 | **Forgot password:** the first link expires after 15 min; asks again; resets; the old phone is signed out | J |
| JOUR-05 | **Blocked and unblocked** applicator | J |
| JOUR-06 | **Staff lockout** and owner unlock | J |
| JOUR-07 | **Admin day:** owner makes 500 coupons; factory exports and moves it to in market; Mohan scans; Raju calls "code not working"; helpline finds Mohan, when and where, with the number masked | J |
| JOUR-08 | **Midnight:** 11:59 pm vs 12:01 am — coupons, spins and quests reset | J |
| JOUR-09 | **Month end:** the ₹15,000 cap restarts on the 1st | J |
| JOUR-10 | **Offline:** a 2-day-old scan counts on its day; a 10-day-old one is refused | J |
| JOUR-11 | **Settings change:** owner lowers the minimum; it applies at once and is audited | J |

## 11. High traffic (load)

| ID | Scenario | Pass gate | Where |
|---|---|---|---|
| LOAD-01 | Smoke (5 users) | All gates | `load/k6/gomax.js` smoke |
| LOAD-02 | Launch-day peak (2,000 users, real think time) | Home p95 < 400 ms · scan p95 < 600 ms · < 0.5% 5xx · no fresh code refused | peak |
| LOAD-03 | Morning scan rush (200 scans/s, 10 min) | Scan p95 < 600 ms, p99 < 1.2 s | scan_rush |
| LOAD-04 | Login storm after an app update (150 logins/s) | Login p95 < 1.5 s, no errors | login_storm |
| LOAD-05 | Midnight spins (1,000 people within 10 s) | Spin p95 < 500 ms; exactly 3 each | midnight_spins |
| LOAD-06 | One-hour soak (500 users) | No growth in latency or errors over time | soak |

Local dry-run results are in [../load/README.md](../load/README.md#results-from-a-local-dry-run-2122-oct-2026). The real numbers must come from staging.

## 12. Manual checks on phones 📱 (app not yet connected to the API)

| ID | Case | Expected |
|---|---|---|
| APP-M1 | Cheap Android (2 GB RAM, Android 9), Hindi selected | Screens readable; no cut-off text; scan works |
| APP-M2 | Slow network (2G/3G throttled) | Spinners, then the result; no double submits on scan / withdraw / gift |
| APP-M3 | Network drops mid-withdraw | The request is either created once or not at all; Wallet shows the truth on reopen |
| APP-M4 | App killed and reopened after 1 day / after 100 days | Stays signed in (token refresh) / asked to log in again |
| APP-M5 | Two phones, same account | Both work; balances match after refresh |
| APP-M6 | WhatsApp reset link on a phone with the app installed | Opens the app's new-password screen |
| APP-M7 | Punjabi and Hindi texts on every screen | Fit their boxes; no English left (client to supply 8 Punjabi texts) |
| APP-M8 | Camera-only streak photo | Gallery not offered; photo time and GPS stamped |
| APP-M9 | iPhone (Safari web build) and Android | Same behaviour |
