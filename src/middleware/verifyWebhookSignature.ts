import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const SIGNATURE_HEADER = 'x-bank-signature';

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function verifyWebhookSignature(req: RawBodyRequest, res: Response, next: NextFunction): void {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error('WEBHOOK_SECRET is not configured');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  const signatureHeader = req.header(SIGNATURE_HEADER);
  const rawBody = req.rawBody;

  if (!signatureHeader || !rawBody) {
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(signatureHeader, 'hex');

  const isValid =
    expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!isValid) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}
