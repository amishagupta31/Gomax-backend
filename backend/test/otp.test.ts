// Sign-up SMS OTP via Firebase Phone Auth. Tokens are signed here with our
// own RSA key exactly like Google signs Firebase ID tokens, so the real
// verification code (src/lib/firebase.ts) runs without calling Google.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.js';
import { firebasePhoneVerifier } from '../src/lib/firebase.js';
import { setup, type Ctx } from './helpers.js';

const PROJECT = 'gomax-test';
let c: Ctx;
let signFirebase: (claims: Record<string, unknown>, opts?: { iss?: string; aud?: string; key?: 'good' | 'other'; exp?: number; authTime?: number }) => Promise<string>;

beforeAll(async () => {
  const good = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const holder: { now: () => Date } = { now: () => new Date() };
  c = await setup({ verifyPhone: firebasePhoneVerifier(PROJECT, createLocalJWKSet({ keys: [jwk] }), () => holder.now()) });
  holder.now = c.clock.now;
  signFirebase = async (claims, o = {}) => {
    const nowSec = Math.floor(c.clock.now().getTime() / 1000);
    return new SignJWT({ auth_time: o.authTime ?? nowSec - 30, firebase: { sign_in_provider: 'phone', identities: {} }, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(o.iss ?? `https://securetoken.google.com/${PROJECT}`)
      .setAudience(o.aud ?? PROJECT)
      .setSubject('firebase-uid-123')
      .setIssuedAt(nowSec - 30)
      .setExpirationTime(o.exp ?? nowSec + 3600)
      .sign(o.key === 'other' ? other.privateKey : good.privateKey);
  };
});
afterAll(async () => {
  await c.close();
});

const body = (mobile: string, firebaseToken?: string) => ({ name: 'Otp User', mobile, password: 'secret123', firebaseToken });

describe('sign-up with SMS OTP (Firebase Phone Auth)', () => {
  test('a valid OTP token for the same number creates the account and records the check', async () => {
    const tok = await signFirebase({ phone_number: '+919812300001' });
    const r = await c.api().post('/v1/auth/signup', body('98123 00001', tok));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.accessToken).toBeTruthy(); // GoMax's own login, not the Firebase token
    const [u] = await c.db.select().from(users).where(eq(users.mobile, '9812300001'));
    expect(u.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(u.firebaseUid).toBe('firebase-uid-123');
    // From now on the person logs in with mobile + password only (no OTP).
    expect((await c.api().post('/v1/auth/login', { mobile: '9812300001', password: 'secret123' })).status).toBe(200);
  });

  test('no OTP token → 400 otp_required', async () => {
    const r = await c.api().post('/v1/auth/signup', body('9812300002'));
    expect(r.body.error.code).toBe('otp_required');
  });

  test('OTP done on one number, signing up another → 400 otp_mobile_mismatch', async () => {
    const tok = await signFirebase({ phone_number: '+919812300003' });
    const r = await c.api().post('/v1/auth/signup', body('9812300004', tok));
    expect(r.body.error.code).toBe('otp_mobile_mismatch');
  });

  test.each([
    ['signed by someone other than Google', { key: 'other' as const }],
    ['for another Firebase project', { aud: 'someone-elses-project' }],
    ['from another issuer', { iss: 'https://securetoken.google.com/someone-else' }],
    ['expired', { exp: Math.floor(new Date('2026-10-12T05:00:00Z').getTime() / 1000) - 10 }],
    ['OTP entered more than 10 min ago', { authTime: Math.floor(new Date('2026-10-12T05:00:00Z').getTime() / 1000) - 11 * 60 }],
  ])('token %s → 401 otp_invalid', async (_name, opts) => {
    const tok = await signFirebase({ phone_number: '+919812300005' }, opts);
    const r = await c.api().post('/v1/auth/signup', body('9812300005', tok));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('otp_invalid');
  });

  test('a Firebase sign-in that was not a phone OTP (e.g. Google account) → 401', async () => {
    const tok = await signFirebase({ phone_number: '+919812300006', firebase: { sign_in_provider: 'google.com' } });
    expect((await c.api().post('/v1/auth/signup', body('9812300006', tok))).body.error.code).toBe('otp_invalid');
  });

  test('a non-Indian number → 401', async () => {
    const tok = await signFirebase({ phone_number: '+14155550100' });
    expect((await c.api().post('/v1/auth/signup', body('9812300007', tok))).body.error.code).toBe('otp_invalid');
  });

  test('a tampered token (number edited) → 401', async () => {
    const tok = await signFirebase({ phone_number: '+919812300008' });
    const [h, p, s] = tok.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    claims.phone_number = '+919812300009';
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
    expect((await c.api().post('/v1/auth/signup', body('9812300009', forged))).body.error.code).toBe('otp_invalid');
  });

  test('a valid OTP token reused for a number that already has an account → 409', async () => {
    const tok = await signFirebase({ phone_number: '+919812300001' });
    expect((await c.api().post('/v1/auth/signup', body('9812300001', tok))).body.error.code).toBe('mobile_taken');
  });
});
