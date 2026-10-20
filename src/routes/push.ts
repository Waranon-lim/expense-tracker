import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { requireUser } from '../middleware/requireUser';
import { vapidPublicKey } from '../services/pushNotifications';

export const pushRouter = Router();

const SubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
});

// The browser needs this public key to create a subscription tied to this server.
// It is public on purpose: it is not a secret.
pushRouter.get('/public-key', (_req, res) => {
  const key = vapidPublicKey();
  if (!key) {
    res.status(503).json({ error: 'Push notifications are not configured on the server' });
    return;
  }
  res.status(200).json({ key });
});

// A device (endpoint) belongs to whoever subscribed last on it.
pushRouter.post(
  '/subscribe',
  requireUser,
  asyncHandler(async (req, res) => {
    const parsed = SubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid subscription' });
      return;
    }
    const { endpoint, keys } = parsed.data;
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [endpoint, req.userId, keys.p256dh, keys.auth],
    );
    res.status(201).json({ subscribed: true });
  }),
);

pushRouter.post(
  '/unsubscribe',
  requireUser,
  asyncHandler(async (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.userId]);
    res.status(200).json({ subscribed: false });
  }),
);
