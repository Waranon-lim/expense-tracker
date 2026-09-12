import express from 'express';
import dotenv from 'dotenv';

import { verifyWebhookSignature, type RawBodyRequest } from './middleware/verifyWebhookSignature';
import { webhookRouter } from './routes/webhook';
import { expensesRouter } from './routes/expenses';
import { pool } from './db/pool';
import { startCategorizationSweep } from './jobs/categorizationSweep';

dotenv.config();

const app = express();

const CATEGORIZATION_TIMEOUT_MS = process.env.CATEGORIZATION_TIMEOUT_MS
  ? Number(process.env.CATEGORIZATION_TIMEOUT_MS)
  : 30_000;
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
app.use('/api/expenses', expensesRouter);

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
