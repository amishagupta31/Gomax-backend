// Authentication attacks and storage checks: forged / expired / unsigned
// tokens, how secrets are stored, roles taken from the DB (not the token),
// PIN brute force, and the rate limits actually firing.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SignJWT } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { refreshTokens, staff, users } from '../src/db/schema.js';
import { setup, type Ctx } from './helpers.js';

let c: Ctx;
beforeAll(async () => {
  c = await setup();
});
afterAll(async () => {
  await c.close();
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (payload: Record<string, unknown>, secret: string, opts: { exp?: number | string; iss?: string } = {}) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(opts.iss ?? 'gomax-api')
    .setExpirationTime(opts.exp ?? '15m')
    .sign(new TextEncoder().encode(secret));

describe('access tokens (JWT, HS256, 15 min)', () => {
  test('a valid token works', async () => {
    const u = await c.signup();
    expect((await u.api.get('/v1/me')).status).toBe(200);
  });

  test('changing the user id inside a token breaks its signature → 401', async () => {
    const victim = await c.signup({ name: 'Victim' });
    const attacker = await c.signup({ name: 'Attacker' });
    const [h, , s] = attacker.token.split('.');
    const forged = `${h}.${b64({ sub: victim.id, typ: 'user', iss: 'gomax-api', iat: 1, exp: 4_000_000_000 })}.${s}`;
    expect((await c.api(forged).get('/v1/me')).status).toBe(401);
  });

  test('an unsigned token (alg "none") → 401', async () => {
    const u = await c.signup();
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: u.id, typ: 'user', iss: 'gomax-api', exp: 4_000_000_000 })}.`;
    expect((await c.api(none).get('/v1/me')).status).toBe(401);
  });

  test('a token signed with another secret → 401', async () => {
    const u = await c.signup();
    const other = await sign({ sub: u.id, typ: 'user' }, 'some-other-server-secret-0123456789abcdef');
    expect((await c.api(other).get('/v1/me')).status).toBe(401);
  });

  test('an expired token → 401 (the app must refresh)', async () => {
    const u = await c.signup();
    const expired = await sign({ sub: u.id, typ: 'user' }, c.config.JWT_SECRET, { exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await c.api(expired).get('/v1/me')).status).toBe(401);
  });

  test('a token from another issuer → 401', async () => {
    const u = await c.signup();
    const foreign = await sign({ sub: u.id, typ: 'user' }, c.config.JWT_SECRET, { iss: 'someone-else' });
    expect((await c.api(foreign).get('/v1/me')).status).toBe(401);
  });

  test('a user token claiming to be staff (typ changed) is useless without the secret', async () => {
    const u = await c.signup();
    const [h, , s] = u.token.split('.');
    const forged = `${h}.${b64({ sub: u.id, typ: 'staff', role: 'owner', iss: 'gomax-api', exp: 4_000_000_000 })}.${s}`;
    expect((await c.api(forged).get('/v1/admin/dashboard')).status).toBe(401);
  });

  test('garbage in the Authorization header → 401, never 500', async () => {
    for (const h of ['Bearer', 'Bearer x.y.z', 'Basic abc', 'Bearer ' + 'a'.repeat(5000)]) {
      const r = await c.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: h } });
      expect(r.statusCode).toBe(401);
    }
  });
});

describe('refresh tokens (random, stored hashed, rotated)', () => {
  test('stored only as a SHA-256 hash, never in plain text', async () => {
    const u = await c.signup();
    const rows = await c.db.select().from(refreshTokens).where(eq(refreshTokens.subjectId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].tokenHash).not.toBe(u.refresh);
  });

  test('a user refresh token cannot be used on the admin refresh route', async () => {
    const u = await c.signup();
    expect((await c.api().post('/v1/admin/auth/refresh', { refreshToken: u.refresh })).status).toBe(401);
  });

  test('a stolen refresh token stops working once the real app has used it', async () => {
    const u = await c.signup();
    const real = await c.api().post('/v1/auth/refresh', { refreshToken: u.refresh });
    expect(real.status).toBe(200);
    expect((await c.api().post('/v1/auth/refresh', { refreshToken: u.refresh })).status).toBe(401);
  });

  test('expires after 90 days', async () => {
    const u = await c.signup();
    c.clock.days(91);
    expect((await c.api().post('/v1/auth/refresh', { refreshToken: u.refresh })).status).toBe(401);
    c.clock.days(-91);
  });
});

describe('passwords and PINs', () => {
  test('stored as argon2id hashes only', async () => {
    const u = await c.signup();
    const [row] = await c.db.select({ h: users.passwordHash }).from(users).where(eq(users.id, u.id));
    expect(row.h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(row.h).not.toContain('secret123');
    const [s] = await c.db.select({ p: staff.passwordHash, pin: staff.pinHash }).from(staff).where(eq(staff.loginId, 'owner'));
    expect(s.p.startsWith('$argon2id$')).toBe(true);
    expect(s.pin.startsWith('$argon2id$')).toBe(true);
  });

  test('odd input is rejected cleanly (no 500): injection-looking mobile, huge password', async () => {
    const api = c.api();
    expect((await api.post('/v1/auth/login', { mobile: "98765' OR '1'='1", password: 'x' })).status).toBe(400);
    expect((await api.post('/v1/auth/login', { mobile: '9876543210', password: 'x'.repeat(10_000) })).status).toBe(400);
    expect((await api.post('/v1/auth/login', { mobile: ['9876543210'], password: 'x' })).status).toBe(400);
    const r = await c.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(r.statusCode).toBe(400);
  });
});

describe('staff: roles come from the database, not the token', () => {
  const login = async (loginId: string, password: string, pin: string) => {
    const r = await c.api().post('/v1/admin/auth/login', { loginId, password, pin });
    return { status: r.status, body: r.body, api: c.api(r.body.accessToken) };
  };

  test('demoting a staff member takes effect on their very next request', async () => {
    const owner = await c.ownerLogin();
    const s = (await owner.post('/v1/admin/staff', { loginId: 'demote1', name: 'Demote', role: 'accounts', password: 'demote-pass-1', pin: '1212' })).body;
    const { api } = await login('demote1', 'demote-pass-1', '1212');
    expect((await api.get('/v1/admin/withdrawals')).status).toBe(200);
    await owner.patch(`/v1/admin/staff/${s.id}`, { role: 'factory' });
    expect((await api.get('/v1/admin/withdrawals')).status).toBe(403); // same token, new role
  });

  test('deactivating a staff member cuts off their open session at once', async () => {
    const owner = await c.ownerLogin();
    const s = (await owner.post('/v1/admin/staff', { loginId: 'leaver1', name: 'Leaver', role: 'accounts', password: 'leaver-pass-1', pin: '1313' })).body;
    const { api } = await login('leaver1', 'leaver-pass-1', '1313');
    await owner.patch(`/v1/admin/staff/${s.id}`, { active: false });
    expect((await api.get('/v1/admin/withdrawals')).status).toBe(401);
    expect((await login('leaver1', 'leaver-pass-1', '1313')).status).toBe(401);
  });

  test('admin login: email + password is enough, no PIN; a wrong password fails without saying which part', async () => {
    const owner = await c.ownerLogin();
    await owner.post('/v1/admin/staff', { loginId: 'Pinny@Example.com', name: 'Pinny', role: 'accounts', password: 'pinny-pass-1', pin: '1414' });
    const ok = await c.api().post('/v1/admin/auth/login', { loginId: 'pinny@example.com', password: 'pinny-pass-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.staff).toMatchObject({ loginId: 'pinny@example.com', role: 'accounts' });
    const bad = await c.api().post('/v1/admin/auth/login', { loginId: 'pinny@example.com', password: 'wrong-pass-11' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toMatchObject({ code: 'wrong_login', message: 'Wrong email or password' });
  });

  test('PIN brute force on a money action: 5 wrong PINs lock the login and sign it out', async () => {
    const owner = await c.ownerLogin();
    await owner.post('/v1/admin/staff', { loginId: 'brute1', name: 'Brute', role: 'accounts', password: 'brute-pass-11', pin: '4321' });
    const { api } = await login('brute1', 'brute-pass-11', '4321');
    const u = await c.signup({ name: 'Brute Target' });
    await owner.post(`/v1/admin/applicators/${u.id}/adjust`, { wallet: 'points', amount: 600, reason: 'test' });
    await c.kyc(u);
    const w = (await u.api.post('/v1/withdrawals', { amount: 500 })).body;
    const tries = [];
    for (const pin of ['0000', '1111', '2222', '3333']) tries.push(await api.post(`/v1/admin/withdrawals/${w.id}/approve`, { pin }));
    expect(tries.map((t) => t.body.error.triesLeft)).toEqual([4, 3, 2, 1]);
    const fifth = await api.post(`/v1/admin/withdrawals/${w.id}/approve`, { pin: '5555' });
    expect(fifth.status).toBe(401);
    // Even the right PIN now fails: the session is locked and signed out.
    expect((await api.post(`/v1/admin/withdrawals/${w.id}/approve`, { pin: '4321' })).status).toBe(401);
    expect((await login('brute1', 'brute-pass-11', '4321')).body.error.code).toBe('locked');
    // The withdrawal was never approved.
    expect((await u.api.get(`/v1/withdrawals/${w.id}`)).body.status).toBe('requested');
  });

  test('a correct PIN resets the wrong-PIN count', async () => {
    const owner = await c.ownerLogin();
    await owner.post('/v1/admin/staff', { loginId: 'reset1', name: 'Reset', role: 'accounts', password: 'reset-pass-11', pin: '2468' });
    const { api } = await login('reset1', 'reset-pass-11', '2468');
    const mk = async () => {
      const u = await c.signup();
      await owner.post(`/v1/admin/applicators/${u.id}/adjust`, { wallet: 'points', amount: 600, reason: 'test' });
      await c.kyc(u);
      return (await u.api.post('/v1/withdrawals', { amount: 500 })).body.id as string;
    };
    const w1 = await mk();
    for (let i = 0; i < 4; i++) await api.post(`/v1/admin/withdrawals/${w1}/approve`, { pin: '0000' });
    expect((await api.post(`/v1/admin/withdrawals/${w1}/approve`, { pin: '2468' })).status).toBe(200);
    const w2 = await mk();
    expect((await api.post(`/v1/admin/withdrawals/${w2}/approve`, { pin: '0000' })).body.error.triesLeft).toBe(4);
  });
});

describe('rate limits are really on (outside tests)', () => {
  test('login: 10 a minute per IP, then 429', async () => {
    const d = await setup({ env: { NODE_ENV: 'development', LOG_LEVEL: 'silent' } });
    try {
      const codes = [];
      for (let i = 0; i < 12; i++) codes.push((await d.api().post('/v1/auth/login', { mobile: '9000000123', password: 'whatever1' })).status);
      expect(codes.slice(0, 10).every((s) => s === 404)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
      const r = await d.api().post('/v1/auth/login', { mobile: '9000000123', password: 'whatever1' });
      expect(r.body.error.code).toBe('too_many_requests');
    } finally {
      await d.close();
    }
  });

  test('the load-test key skips the limiter only when configured, and never in prod', async () => {
    const d = await setup({ env: { NODE_ENV: 'development', LOG_LEVEL: 'silent', LOADTEST_KEY: 'k'.repeat(30) } });
    try {
      const statuses = [];
      for (let i = 0; i < 15; i++) {
        const r = await d.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'x-loadtest-key': 'k'.repeat(30) }, payload: { mobile: '9000000124', password: 'whatever1' } });
        statuses.push(r.statusCode);
      }
      expect(statuses.every((s) => s === 404)).toBe(true);
      const wrongKey = [];
      for (let i = 0; i < 12; i++) {
        const r = await d.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'x-loadtest-key': 'wrong' }, payload: { mobile: '9000000124', password: 'whatever1' } });
        wrongKey.push(r.statusCode);
      }
      expect(wrongKey).toContain(429);
    } finally {
      await d.close();
    }
    await expect(setup({ env: { APP_ENV: 'prod', LOADTEST_KEY: 'k'.repeat(30) } })).rejects.toThrow(/never be set in prod/);
  });
});

describe('database-level protection', () => {
  test('the API cannot be tricked into reading another user through query params', async () => {
    const a = await c.signup();
    const b = await c.signup();
    const w = await a.api.get(`/v1/withdrawals?userId=${b.id}`);
    expect(w.status).toBe(200);
    expect(w.body.withdrawals).toEqual([]);
    // b's gift order id is not visible to a.
    await (await c.ownerLogin()).post(`/v1/admin/applicators/${b.id}/adjust`, { wallet: 'runs', amount: 100, reason: 'test' });
    const order = (await b.api.post('/v1/gift-orders', { giftId: 'watch', address: { name: 'B B', mobile: '9876543210', street: 'Street 12345', city: 'Amritsar', pin: '143001' } })).body;
    expect((await a.api.get(`/v1/gift-orders/${order.id}`)).status).toBe(404);
  });

  test('passwords never appear in any API response', async () => {
    const u = await c.signup();
    for (const path of ['/v1/me', '/v1/home', '/v1/wallet']) {
      const body = JSON.stringify((await u.api.get(path)).body);
      expect(body).not.toMatch(/argon2|password|secret123/i);
    }
    const owner = await c.ownerLogin();
    const staffList = JSON.stringify((await owner.get('/v1/admin/staff')).body);
    expect(staffList).not.toMatch(/argon2|pinHash|passwordHash/i);
    const appl = JSON.stringify((await owner.get(`/v1/admin/applicators/${u.id}`)).body);
    expect(appl).not.toMatch(/argon2|passwordHash/i);
  });

  test('unknown routes and methods → 404, never a stack trace', async () => {
    const r = await c.app.inject({ method: 'GET', url: '/v1/admin/../../etc/passwd' });
    expect([400, 404]).toContain(r.statusCode);
    expect(r.body).not.toMatch(/at .*\.ts:|node_modules/);
    void sql;
  });
});
