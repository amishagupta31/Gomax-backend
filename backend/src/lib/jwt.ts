import { SignJWT, jwtVerify } from 'jose';

export type Claims =
  | { sub: string; typ: 'user' }
  | { sub: string; typ: 'staff'; role: string };

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_DAYS = { user: 90, staff: 1 } as const;

const key = (secret: string) => new TextEncoder().encode(secret);

export function signAccess(claims: Claims, secret: string) {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('gomax-api')
    .setExpirationTime(`${ACCESS_TTL_SEC}s`)
    .sign(key(secret));
}

export async function verifyAccess(token: string, secret: string): Promise<Claims> {
  const { payload } = await jwtVerify(token, key(secret), { issuer: 'gomax-api', algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string' || (payload.typ !== 'user' && payload.typ !== 'staff')) throw new Error('bad token');
  return payload as unknown as Claims;
}
