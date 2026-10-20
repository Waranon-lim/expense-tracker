import crypto from 'node:crypto';
import type { Pool } from 'pg';
import webpush from 'web-push';

let configured: boolean | null = null;

// Read lazily: dotenv.config() runs after imports are evaluated.
function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID keys not set, phone notifications are disabled');
    configured = false;
  } else {
    webpush.setVapidDetails(VAPID_SUBJECT ?? 'mailto:dev@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
  }
  return configured;
}

export function vapidPublicKey(): string | null {
  return ensureConfigured() ? (process.env.VAPID_PUBLIC_KEY as string) : null;
}

// The notification's buttons are clicked inside a service worker, which has no
// signed-in session. So each push carries a token that is valid for exactly one
// thing: categorizing THAT expense. It's an HMAC of the expense id, so it can't
// be forged or reused on another expense, and the route also refuses anything
// that isn't still pending. NOTIFICATION_SECRET (in .env) is the HMAC key.
function tokenSecret(): string {
  const secret = process.env.NOTIFICATION_SECRET;
  if (!secret) throw new Error('NOTIFICATION_SECRET is not configured');
  return `notification-token:${secret}`;
}

export function signNotificationToken(expenseId: number | string): string {
  return crypto.createHmac('sha256', tokenSecret()).update(String(expenseId)).digest('hex');
}

export function verifyNotificationToken(expenseId: number | string, token: string): boolean {
  if (!process.env.NOTIFICATION_SECRET) return false;
  const expected = Buffer.from(signNotificationToken(expenseId));
  const provided = Buffer.from(token);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

export interface NewPaymentNotice {
  expenseId: number;
  userId: string;
  merchant: string;
  amount: number;
  currency: string;
  suggestedCategory: string;
  timeoutMs: number;
}

// Sends "new payment" to every device this user subscribed. Never throws: a
// failed notification must not fail the payment ingest that triggered it.
export async function notifyNewPayment(pool: Pool, notice: NewPaymentNotice): Promise<void> {
  if (!ensureConfigured()) return;
  try {
    const { rows } = await pool.query('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [
      notice.userId,
    ]);
    const payload = JSON.stringify({
      expenseId: notice.expenseId,
      token: signNotificationToken(notice.expenseId),
      merchant: notice.merchant,
      amount: notice.amount,
      currency: notice.currency,
      suggestedCategory: notice.suggestedCategory,
      timeoutSeconds: Math.round(notice.timeoutMs / 1000),
    });

    await Promise.all(
      rows.map(async (sub) => {
        try {
          // TTL: no point delivering "pick a category" after it auto-filed.
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: Math.max(30, Math.round(notice.timeoutMs / 1000)), urgency: 'high' },
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // The device unsubscribed or uninstalled: forget it.
            await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
          } else {
            console.error('[push] send failed:', status ?? err);
          }
        }
      }),
    );
  } catch (err) {
    console.error('[push] notifyNewPayment failed:', err);
  }
}
