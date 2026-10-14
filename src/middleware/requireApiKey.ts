import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const API_KEY_HEADER = 'x-api-key';

// Protects mutating dashboard endpoints (simulate/categorize/delete-category).
// Same shared-secret model as verifyWebhookSignature: a single static key
// (this is a single-user local tool, not a multi-tenant product), checked
// with a timing-safe comparison so response time can't leak how much of the
// key a guess got right.
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.DASHBOARD_API_KEY;
  if (!key) {
    console.error('DASHBOARD_API_KEY is not configured');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  const provided = req.header(API_KEY_HEADER);
  if (!provided) {
    res.status(401).json({ error: 'Missing API key' });
    return;
  }

  const expectedBuf = Buffer.from(key);
  const providedBuf = Buffer.from(provided);

  const isValid = expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!isValid) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  next();
}
