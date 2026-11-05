import { Storage as Gcs } from '@google-cloud/storage';
import type { Config } from '../config.js';

// Private bucket. The app uploads and downloads with short-lived V4 signed
// URLs, so files never pass through Cloud Run and nothing is public.
export interface FileStore {
  signedPut(object: string, contentType: string, maxBytes?: number): Promise<{ url: string; headers: Record<string, string>; expiresAt: Date }>;
  signedGet(object: string): Promise<string>;
  exists(object: string): Promise<boolean>;
}

const PUT_TTL_MS = 10 * 60 * 1000;
const GET_TTL_MS = 60 * 60 * 1000;

export function gcsStore(bucketName: string): FileStore {
  const bucket = new Gcs().bucket(bucketName);
  return {
    async signedPut(object, contentType, maxBytes) {
      const expires = Date.now() + PUT_TTL_MS;
      const extensionHeaders: Record<string, string> = maxBytes ? { 'x-goog-content-length-range': `0,${maxBytes}` } : {};
      const [url] = await bucket.file(object).getSignedUrl({ version: 'v4', action: 'write', expires, contentType, extensionHeaders });
      return { url, headers: { 'Content-Type': contentType, ...extensionHeaders }, expiresAt: new Date(expires) };
    },
    async signedGet(object) {
      const [url] = await bucket.file(object).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + GET_TTL_MS });
      return url;
    },
    async exists(object) {
      const [ok] = await bucket.file(object).exists();
      return ok;
    },
  };
}

/** Local dev / tests: remembers "uploaded" objects in memory. */
export function memoryStore(): FileStore & { put(object: string): void } {
  const objects = new Set<string>();
  return {
    put: (o) => void objects.add(o),
    async signedPut(object, contentType) {
      objects.add(object); // dev: behave as if the signed URL was used
      return { url: `memory://upload/${object}`, headers: { 'Content-Type': contentType }, expiresAt: new Date(Date.now() + PUT_TTL_MS) };
    },
    signedGet: async (object) => `memory://download/${object}`,
    exists: async (object) => objects.has(object),
  };
}

export const createStore = (c: Config): FileStore => (c.STORAGE_DRIVER === 'gcs' ? gcsStore(c.STORAGE_BUCKET) : memoryStore());
