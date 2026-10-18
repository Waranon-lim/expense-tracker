import type { Pool } from 'pg';
import { loadMerchantRules, suggestCategory } from './merchantRules';
import { notifyNewPayment } from './pushNotifications';
import { categorizationTimeoutMs } from '../constants';

export interface IngestTransactionParams {
  provider: string;
  providerTransactionId: string;
  userId: string;
  amount: number;
  currency: string;
  merchantName: string;
  bankCategory: string;
  timestamp: string;
  payload?: unknown;
}

export type IngestTransactionResult =
  | { duplicate: true }
  | { duplicate: false; expenseId: number; suggestedCategory: string };

// Shared by the real bank webhook route and the UI's "simulate transaction"
// dev endpoint — both need the exact same idempotent insert + pending-status
// behavior, just from different payload sources.
export async function ingestTransaction(
  pool: Pool,
  params: IngestTransactionParams,
): Promise<IngestTransactionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ledgerResult = await client.query(
      `INSERT INTO processed_webhooks (provider, provider_transaction_id, status, payload)
       VALUES ($1, $2, 'received', $3)
       ON CONFLICT (provider, provider_transaction_id) DO NOTHING
       RETURNING id`,
      [params.provider, params.providerTransactionId, params.payload ?? {}],
    );

    if (ledgerResult.rowCount === 0) {
      await client.query('COMMIT');
      return { duplicate: true };
    }

    const webhookId = ledgerResult.rows[0].id as number;

    const expenseResult = await client.query(
      `INSERT INTO expenses (
         user_id, amount, currency, merchant, raw_bank_category,
         status, source, webhook_id, transaction_date
       ) VALUES ($1, $2, $3, $4, $5, 'pending', 'bank_webhook', $6, $7)
       RETURNING id`,
      [
        params.userId,
        params.amount,
        params.currency,
        params.merchantName,
        params.bankCategory,
        webhookId,
        params.timestamp,
      ],
    );

    const expenseId = expenseResult.rows[0].id as number;

    await client.query(`UPDATE processed_webhooks SET status = 'processing' WHERE id = $1`, [webhookId]);

    await client.query('COMMIT');

    const rules = await loadMerchantRules(pool, params.userId);
    const { category: suggestedCategory } = suggestCategory(rules, params.merchantName, params.bankCategory);

    // Fire-and-forget: the payment is already saved, and a slow or failing
    // push service must not delay (or fail) the webhook response.
    void notifyNewPayment(pool, {
      expenseId,
      userId: params.userId,
      merchant: params.merchantName,
      amount: params.amount,
      currency: params.currency,
      suggestedCategory,
      timeoutMs: categorizationTimeoutMs(),
    });

    return { duplicate: false, expenseId, suggestedCategory };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
