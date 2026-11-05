import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

// Sign-up phone check (A1-07): the app proves the number with Firebase Phone
// Auth (SMS OTP) and sends us the Firebase ID token. We verify it ourselves
// against Google's published keys — no Firebase SDK on the server — and only
// use it to learn "this person owns +91XXXXXXXXXX". GoMax issues its own login.

/** Google's signing keys for Firebase ID tokens (cached and rotated by jose). */
export const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** The OTP must have been entered within this window before sign-up. */
export const OTP_MAX_AGE_SEC = 10 * 60;

export type PhoneProof = { mobile: string; firebaseUid: string };
export type PhoneVerifier = (token: string) => Promise<PhoneProof>;

export class PhoneTokenError extends Error {}

export function firebasePhoneVerifier(projectId: string, keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL)), now: () => Date = () => new Date()): PhoneVerifier {
  return async (token) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
        currentDate: now(),
      }));
    } catch {
      throw new PhoneTokenError('OTP check failed or expired');
    }
    const firebase = payload.firebase as { sign_in_provider?: string } | undefined;
    if (firebase?.sign_in_provider !== 'phone') throw new PhoneTokenError('Not a phone OTP sign-in');
    const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : 0;
    const age = now().getTime() / 1000 - authTime;
    if (age > OTP_MAX_AGE_SEC || age < -60) throw new PhoneTokenError('OTP is too old — verify the number again');
    const phone = typeof payload.phone_number === 'string' ? payload.phone_number : '';
    const m = phone.match(/^\+91([6-9]\d{9})$/);
    if (!m || typeof payload.sub !== 'string' || !payload.sub) throw new PhoneTokenError('Only Indian mobile numbers are supported');
    return { mobile: m[1], firebaseUid: payload.sub };
  };
}
