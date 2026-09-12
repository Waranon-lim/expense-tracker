import { Router } from 'express';
import { pool } from '../db/pool';
import { BankWebhookPayloadSchema } from '../validation/webhookSchema';
import { mapBankCategory } from '../services/categoryMapping';

export const webhookRouter = Router();

const PROVIDER = 'mock_bank';

webhookRouter.post('/bank-sync', async (req, res) => {
  const parseResult = BankWebhookPayloadSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: 'Invalid payload', details: parseResult.error.flatten() });
    return;
  }
  const payload = parseResult.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ledgerResult = await client.query(
      `INSERT INTO processed_webhooks (provider, provider_transaction_id, status, payload)
       VALUES ($1, $2, 'received', $3)
       ON CONFLICT (provider, provider_transaction_id) DO NOTHING
       RETURNING id`,
      [PROVIDER, payload.transaction_id, payload],
    );

    if (ledgerResult.rowCount === 0) {
      // Same provider_transaction_id already exists: at-least-once delivery duplicate.
      // Do not touch expenses again; ack so the sender stops retrying.
      await client.query('COMMIT');
      res.status(200).json({ status: 'duplicate_ignored' });
      return;
    }

    const webhookId = ledgerResult.rows[0].id as number;

    // Category is intentionally left unset here — the user gets up to
    // CATEGORIZATION_TIMEOUT_MS to tap a category via POST /api/expenses/:id/categorize
    // before the timeout sweep (src/jobs/categorizationSweep.ts) applies the mapping's
    // best guess as the fallback. `suggested_category` below is what that fallback would be.
    const expenseResult = await client.query(
      `INSERT INTO expenses (
         user_id, amount, currency, merchant, raw_bank_category,
         status, source, webhook_id, transaction_date
       ) VALUES ($1, $2, $3, $4, $5, 'pending', 'bank_webhook', $6, $7)
       RETURNING id`,
      [
        payload.user_id,
        payload.amount,
        payload.currency,
        payload.merchant_name,
        payload.bank_category,
        webhookId,
        payload.timestamp,
      ],
    );

    const expenseId = expenseResult.rows[0].id as number;

    await client.query(
      `UPDATE processed_webhooks SET status = 'processing' WHERE id = $1`,
      [webhookId],
    );

    await client.query('COMMIT');

    const { category: suggestedCategory } = mapBankCategory(payload.bank_category, payload.merchant_name);
    res.status(200).json({ status: 'pending', expense_id: expenseId, suggested_category: suggestedCategory });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Webhook processing failed:', err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});
