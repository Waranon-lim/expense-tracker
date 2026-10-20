import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';

import { verifyWebhookSignature, type RawBodyRequest } from './middleware/verifyWebhookSignature';
import { webhookRouter } from './routes/webhook';
import { expensesRouter } from './routes/expenses';
import { categoriesRouter } from './routes/categories';
import { rulesRouter } from './routes/rules';
import { authRouter } from './routes/auth';
import { pushRouter } from './routes/push';
import { pool } from './db/pool';
import { categorizationTimeoutMs } from './constants';
import { startCategorizationSweep } from './jobs/categorizationSweep';

dotenv.config();
if (!process.env.NOTIFICATION_SECRET) {
  console.warn('[push] NOTIFICATION_SECRET is not set: the phone-alert buttons are disabled. Set it in .env (openssl rand -hex 32).');
}

const app = express();

const CATEGORIZATION_SWEEP_INTERVAL_MS = process.env.CATEGORIZATION_SWEEP_INTERVAL_MS
  ? Number(process.env.CATEGORIZATION_SWEEP_INTERVAL_MS)
  : 5_000;

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use('/api/webhooks', verifyWebhookSignature, webhookRouter);
app.use('/api/auth', authRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/push', pushRouter);
app.use(express.static(path.join(__dirname, '..', 'public')));

// Catches errors forwarded by asyncHandler (and anything Express itself
// throws synchronously) so a bad request or DB hiccup returns a JSON 500
// instead of crashing the process or falling through to Express's default
// HTML error page. Must be registered last, and must keep all 4 params for
// Express to recognize it as an error handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled request error:', err);
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: 'Internal error' });
});

const CATEGORIZATION_TIMEOUT_MS = categorizationTimeoutMs();

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen(port, () => {
  console.log(`Expense tracker webhook server listening on port ${port}`);
});

startCategorizationSweep(pool, {
  timeoutMs: CATEGORIZATION_TIMEOUT_MS,
  intervalMs: CATEGORIZATION_SWEEP_INTERVAL_MS,
});
console.log(
  `Categorization sweep running every ${CATEGORIZATION_SWEEP_INTERVAL_MS}ms, timeout ${CATEGORIZATION_TIMEOUT_MS}ms`,
);
