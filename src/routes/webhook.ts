import { Router } from 'express';
import { pool } from '../db/pool';
import { BankWebhookPayloadSchema } from '../validation/webhookSchema';
import { ingestTransaction } from '../services/ingestTransaction';
import { userExists } from '../services/users';

export const webhookRouter = Router();

const PROVIDER = 'mock_bank';

webhookRouter.post('/bank-sync', async (req, res) => {
  const parseResult = BankWebhookPayloadSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: 'Invalid payload', details: parseResult.error.flatten() });
    return;
  }
  const payload = parseResult.data;

  try {
    // The bank names a user. Only ids that have an account are accepted, and an
    // unknown id stores nothing (no ledger row, no expense).
    if (!(await userExists(pool, payload.user_id))) {
      res.status(404).json({ error: 'Unknown user' });
      return;
    }

    const result = await ingestTransaction(pool, {
      provider: PROVIDER,
      providerTransactionId: payload.transaction_id,
      userId: payload.user_id,
      amount: payload.amount,
      currency: payload.currency,
      merchantName: payload.merchant_name,
      bankCategory: payload.bank_category,
      timestamp: payload.timestamp,
      payload,
    });

    if (result.duplicate) {
      // Same provider_transaction_id already exists: at-least-once delivery duplicate.
      // Do not touch expenses again; ack so the sender stops retrying.
      res.status(200).json({ status: 'duplicate_ignored' });
      return;
    }

    // Category is intentionally left unset here — the user gets up to
    // CATEGORIZATION_TIMEOUT_MS to tap a category via POST /api/expenses/:id/categorize
    // before the timeout sweep (src/jobs/categorizationSweep.ts) applies the mapping's
    // best guess as the fallback. `suggested_category` below is what that fallback would be.
    res.status(200).json({
      status: 'pending',
      expense_id: result.expenseId,
      suggested_category: result.suggestedCategory,
    });
  } catch (err) {
    console.error('Webhook processing failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
