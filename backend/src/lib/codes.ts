import { randomInt } from 'node:crypto';

// D2: 8 random letters/digits without 0/O/1/I so codes are easy to read and type.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

export function generateCode() {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/**
 * Accepts what the app sends: the raw QR payload (may be a URL such as
 * https://gomax.in/c/ABCD2345 or ?code=…), or a typed code with spaces/dashes
 * or a printed "GMX-" prefix. Returns the canonical 8-char code or null.
 */
export function normalizeCode(raw: string): string | null {
  let s = raw.trim().toUpperCase();
  const fromUrl = s.match(/(?:[?&](?:C|CODE)=|\/C\/)([A-Z0-9-]+)/);
  if (fromUrl) s = fromUrl[1];
  s = s.replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('GMX') && s.length === CODE_LENGTH + 3) s = s.slice(3);
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** Admin reference shown on print sheets and lookups: B-0007-00042. */
export const adminRef = (batchRef: string, serial: number) => `${batchRef}-${String(serial).padStart(5, '0')}`;
