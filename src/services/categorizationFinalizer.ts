import type { Pool } from 'pg';
import type { CategorySource } from '../types/webhook';

export interface FinalizeResult {
  applied: boolean;
  expenseId: number;
}

/**
 * Finalizes a pending expense's category. Guarded by `WHERE status = 'pending'` so
 * whichever caller gets here first (a user tap, or the timeout sweep) wins the race —
 * the loser's UPDATE just affects zero rows instead of overwriting the winner.
 */
export async function finalizeCategory(
  pool: Pool,
  expenseId: number,
  category: string,
  source: Exclude<CategorySource, null>,
): Promise<FinalizeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const expenseResult = await client.query(
      `UPDATE expenses
       SET category = $1, status = 'categorized', category_source = $2,
           categorized_at = now(), updated_at = now()
       WHERE id = $3 AND status = 'pending'
       RETURNING webhook_id`,
      [category, source, expenseId],
    );

    if (expenseResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { applied: false, expenseId };
    }

    const webhookId = expenseResult.rows[0].webhook_id as number;

    await client.query(
      `UPDATE processed_webhooks SET status = 'completed', processed_at = now() WHERE id = $1`,
      [webhookId],
    );

    await client.query('COMMIT');
    return { applied: true, expenseId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
