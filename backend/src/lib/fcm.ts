// Firebase Cloud Messaging via the HTTP v1 API.
// Uses google-auth-library (already installed) — no firebase-admin SDK needed.
// On GCP Cloud Run, Application Default Credentials work automatically.
// Locally: set FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY from a service-account key.
import { GoogleAuth } from 'google-auth-library';

type FcmCfg = { projectId: string; clientEmail?: string; privateKey?: string };

let _cfg: FcmCfg | null = null;
let _auth: GoogleAuth | null = null;

export function initFcm(cfg: FcmCfg) {
  _cfg = cfg;
  _auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    ...(cfg.clientEmail && cfg.privateKey
      ? { credentials: { client_email: cfg.clientEmail, private_key: cfg.privateKey.replace(/\\n/g, '\n') } }
      : {}),
  });
}

export async function sendPush(
  deviceToken: string,
  title: string,
  body: string,
  link?: object,
): Promise<void> {
  if (!_cfg || !_auth) return;
  try {
    const client = await _auth.getClient();
    const tokenResp = await client.getAccessToken();
    if (!tokenResp.token) return;

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${_cfg.projectId}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenResp.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title, body },
            ...(link ? { data: { link: JSON.stringify(link) } } : {}),
            android: { priority: 'high' },
            apns: { payload: { aps: { sound: 'default', badge: 1 } } },
          },
        }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
      console.error('FCM send error:', err?.error?.message ?? res.status);
    }
  } catch (e) {
    console.error('FCM send failed:', e);
  }
}
