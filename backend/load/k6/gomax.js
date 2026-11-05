// GoMax API load test (k6). Run against STAGING only — see load/README.md.
//
//   k6 run -e BASE_URL=https://<staging> -e LOADTEST_KEY=<key> -e SCENARIO=peak load/k6/gomax.js
//
// Scenarios (SCENARIO=…):
//   smoke           5 users, 1 min — checks the script and the environment
//   peak            the launch-day mix: users ramp to PEAK_VUS (default 2000)
//                   doing home / scan / history / spins / notifications with
//                   real think time (5–20 s), held for HOLD (default 20m)
//   scan_rush       morning rush: SCAN_RATE scans per second (default 200) for 10 min
//   login_storm     everyone opens the app after an update: ramps to LOGIN_RATE
//                   logins/s (default 150) — argon2 makes login the costliest call
//   midnight_spins  12:00 am: spins reset and SPIN_USERS people (default 1000) all
//                   spin within seconds — SPIN_RATE spins/s (default 300) for SPIN_FOR (10s)
//   soak            SOAK_VUS users (default 500) for 60 min — leaks, pool exhaustion
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const KEY = __ENV.LOADTEST_KEY || '';
const USERS = Number(__ENV.USERS || 2000);
const MOBILE_BASE = Number(__ENV.MOBILE_BASE || 6000000000);
const PASSWORD = __ENV.PASSWORD || 'loadtest123';
const SCENARIO = __ENV.SCENARIO || 'smoke';
const CODE_OFFSET = Number(__ENV.CODE_OFFSET || 0); // use a fresh slice of codes per run
// Most VUs this run will have — fixes each VU's private slice of fresh codes.
const POOL_VUS = { smoke: 5, peak: Number(__ENV.PEAK_VUS || 2000), soak: Number(__ENV.SOAK_VUS || 500) }[__ENV.SCENARIO || 'smoke'] || 1;
// Real users are already signed in (the app keeps a 90-day refresh token), so
// every scenario except login_storm logs its users in during setup(), before
// the clock starts. Login cost is measured on its own in login_storm.
const PRELOGIN = {
  smoke: 5,
  peak: Number(__ENV.PEAK_VUS || 2000),
  soak: Number(__ENV.SOAK_VUS || 500),
  scan_rush: Number(__ENV.MAX_VUS || 2000),
  midnight_spins: Number(__ENV.SPIN_USERS || 1000),
  login_storm: 0,
}[SCENARIO];

const codes = new SharedArray('codes', () => JSON.parse(open('../data/codes.json')));

const scansAdded = new Counter('scans_added');
const scansUsed = new Counter('scans_used');
const serverErrors = new Rate('server_errors'); // 5xx only — business "no" answers are fine
const unexpected = new Counter('unexpected_answers');

const ramp = (target, up, hold) => [
  { duration: up, target },
  { duration: hold, target },
  { duration: '1m', target: 0 },
];

const SCENARIOS = {
  smoke: { executor: 'constant-vus', vus: 5, duration: '1m', exec: 'appUser' },
  peak: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: ramp(Number(__ENV.PEAK_VUS || 2000), __ENV.RAMP || '10m', __ENV.HOLD || '20m'),
    gracefulRampDown: '30s',
    exec: 'appUser',
  },
  scan_rush: {
    executor: 'constant-arrival-rate',
    rate: Number(__ENV.SCAN_RATE || 200),
    timeUnit: '1s',
    duration: __ENV.DURATION || '10m',
    preAllocatedVUs: 200,
    maxVUs: Number(__ENV.MAX_VUS || 2000),
    exec: 'scanOnce',
  },
  login_storm: {
    executor: 'ramping-arrival-rate',
    startRate: 10,
    timeUnit: '1s',
    preAllocatedVUs: 200,
    maxVUs: Number(__ENV.MAX_VUS || 2000),
    stages: [
      { duration: '1m', target: Number(__ENV.LOGIN_RATE || 150) },
      { duration: __ENV.HOLD || '2m', target: Number(__ENV.LOGIN_RATE || 150) },
      { duration: '30s', target: 0 },
    ],
    exec: 'loginOnce',
  },
  midnight_spins: {
    executor: 'constant-arrival-rate',
    rate: Number(__ENV.SPIN_RATE || 300),
    timeUnit: '1s',
    duration: __ENV.SPIN_FOR || '10s',
    preAllocatedVUs: 300,
    maxVUs: Number(__ENV.MAX_VUS || 1500),
    exec: 'spinAtMidnight',
  },
  soak: { executor: 'constant-vus', vus: Number(__ENV.SOAK_VUS || 500), duration: __ENV.DURATION || '60m', exec: 'appUser' },
};

export const options = {
  scenarios: { [SCENARIO]: SCENARIOS[SCENARIO] },
  thresholds: {
    // Launch gates (ARCHITECTURE.md §9): fail the run if any is missed.
    server_errors: ['rate<0.005'], // < 0.5% 5xx
    unexpected_answers: ['count<1'], // e.g. a fresh code that wasn't "added"
    'http_req_duration{name:home}': ['p(95)<400', 'p(99)<900'],
    'http_req_duration{name:scan}': ['p(95)<600', 'p(99)<1200'],
    'http_req_duration{name:ledger}': ['p(95)<400'],
    'http_req_duration{name:spin}': ['p(95)<500'],
    'http_req_duration{name:login}': ['p(95)<1500'], // login_storm only (setup logins are tagged setup_login)
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '15m',
};

export function setup() {
  const tokens = [];
  const n = Math.min(PRELOGIN, USERS);
  for (let i = 0; i < n; i += 20) {
    const batch = [];
    for (let k = i; k < Math.min(i + 20, n); k++) {
      batch.push(['POST', `${BASE}/v1/auth/login`, JSON.stringify({ mobile: String(MOBILE_BASE + k), password: PASSWORD, deviceId: `load-device-${k}` }), { headers: baseHeaders(), tags: { name: 'setup_login' } }]);
    }
    for (const r of http.batch(batch)) tokens.push(r.status === 200 ? r.json('accessToken') : null);
  }
  return { tokens };
}

// ── helpers ───────────────────────────────────────────────────────────────
const baseHeaders = () => ({ 'Content-Type': 'application/json', 'x-loadtest-key': KEY });
let token = null; // module scope = one per VU

function track(res) {
  serverErrors.add(res.status >= 500);
  return res;
}

function login(userIndex) {
  const mobile = String(MOBILE_BASE + (userIndex % USERS));
  const res = track(http.post(`${BASE}/v1/auth/login`, JSON.stringify({ mobile, password: PASSWORD, deviceId: `load-device-${userIndex % USERS}` }), { headers: baseHeaders(), tags: { name: 'login' } }));
  check(res, { 'login 200': (r) => r.status === 200 });
  return res.status === 200 ? res.json('accessToken') : null;
}

let setupTokens = [];
function authed(method, path, body, name) {
  if (!token) token = setupTokens[(exec.vu.idInTest - 1) % Math.max(1, setupTokens.length)] || login(exec.vu.idInTest - 1);
  if (!token) return null;
  const params = { headers: { ...baseHeaders(), Authorization: `Bearer ${token}` }, tags: { name } };
  let res = track(http.request(method, `${BASE}${path}`, body ? JSON.stringify(body) : null, params));
  if (res.status === 401) {
    // Access tokens last 15 min; a real app refreshes — here we log in again.
    token = login(exec.vu.idInTest - 1);
    if (!token) return res;
    params.headers.Authorization = `Bearer ${token}`;
    res = track(http.request(method, `${BASE}${path}`, body ? JSON.stringify(body) : null, params));
  }
  return res;
}

function scan(code, expectFresh) {
  const res = authed('POST', '/v1/coupons/redeem', { code, source: Math.random() < 0.8 ? 'scan' : 'typed', lat: 31.63 + Math.random() / 100, lng: 74.87 + Math.random() / 100 }, 'scan');
  if (!res) return;
  const kind = res.status === 200 ? res.json('kind') : null;
  if (kind === 'added') {
    scansAdded.add(1);
    lastCode = code;
  }
  if (kind === 'used') scansUsed.add(1);
  if (expectFresh && kind !== 'added' && res.status < 500) unexpected.add(1, { got: String(kind ?? res.status) });
  check(res, { 'scan answered': (r) => r.status === 200 });
}

// Each VU gets its own slice of fresh codes, so concurrent VUs never collide by accident.
let myCodeIndex = 0;
let lastCode = null;
function nextFreshCode() {
  const perVu = Math.max(1, Math.floor((codes.length - CODE_OFFSET) / POOL_VUS));
  if (myCodeIndex >= perVu) return null; // slice used up — seed more codes for longer runs
  const i = CODE_OFFSET + (exec.vu.idInTest - 1) * perVu + myCodeIndex++;
  return i < codes.length ? codes[i] : null;
}

// ── user behaviour ────────────────────────────────────────────────────────
// One app session: open Home, then a mix of what people actually do.
export function appUser(data) {
  setupTokens = data.tokens;
  const home = authed('GET', '/v1/home', null, 'home');
  if (!home) return sleep(5);
  check(home, { 'home 200': (r) => r.status === 200 });
  const r = Math.random();
  if (r < 0.55) {
    // Scans a fresh coupon; 1 in 20 rescans an old one ("already used"); 1 in 50 types a wrong code.
    const x = Math.random();
    if (x < 0.05 && lastCode) scan(lastCode, false);
    else if (x < 0.07) scan('WRONG123', false);
    else {
      const code = nextFreshCode();
      if (code) scan(code, true);
    }
  } else if (r < 0.7) {
    authed('GET', '/v1/ledger?wallet=points&limit=30', null, 'ledger');
  } else if (r < 0.8) {
    const s = authed('POST', '/v1/spins', null, 'spin');
    if (s) check(s, { 'spin ok or none left': (x) => x.status === 200 || x.status === 409 });
  } else if (r < 0.9) {
    authed('GET', '/v1/notifications?limit=20', null, 'notifications');
  } else {
    authed('GET', '/v1/challenges', null, 'challenges');
    authed('GET', '/v1/scratch-cards', null, 'scratch');
  }
  sleep(5 + Math.random() * 15); // think time between taps
}

export function scanOnce(data) {
  setupTokens = data.tokens;
  const i = CODE_OFFSET + exec.scenario.iterationInTest;
  if (i >= codes.length) return;
  scan(codes[i], true);
}

export function loginOnce() {
  login(exec.scenario.iterationInTest);
}

export function spinAtMidnight(data) {
  // Each iteration is a different person (3 free spins each, then "no spins left").
  setupTokens = data.tokens;
  token = data.tokens[exec.scenario.iterationInTest % data.tokens.length];
  const s = authed('POST', '/v1/spins', null, 'spin');
  if (s) check(s, { 'spin ok or none left': (x) => x.status === 200 || x.status === 409 });
}
