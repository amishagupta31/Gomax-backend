import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// argon2id, OWASP-recommended parameters.
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashSecret = (plain: string) => hash(plain, ARGON);
export const verifySecret = (hashed: string, plain: string) => verify(hashed, plain).catch(() => false);

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// PAN at rest: AES-256-GCM, key from Secret Manager (PAN_KEY). iv.tag.cipher, base64url.
export function encrypt(plain: string, keyB64: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(token: string, keyB64: string) {
  const [iv, tag, enc] = token.split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export const maskPan = (pan: string) => `${pan.slice(0, 5)}••••${pan.slice(-1)}`;
