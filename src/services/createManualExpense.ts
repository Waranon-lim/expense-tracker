import type { Pool } from 'pg';
import { registerCategory } from './categorizationFinalizer';

export interface CreateManualExpenseParams {
  userId: string;
  merchant: string;
  amount: number;
  currency: string;
  category: string;
  /** The resolved moment (see resolveManualExpenseDate). */
  when: Date;
}

// Inserts an expense the user typed in by hand. It is categorized at once
// (the user chose the category in the form), so it skips the pending lane.
// It does not teach merchant rules and sends no push notification: the user
// made the entry, so there is nothing to ask or to tell them.
// received_at is set to the same moment as transaction_date because the list,
// charts and summary all filter on received_at.
export async function createManualExpense(pool: Pool, params: CreateManualExpenseParams) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Same registration as a tap: a new name becomes a permanent quick-pick.
    const category = await registerCategory(client, params.category);

    const result = await client.query(
      `INSERT INTO expenses (
         user_id, amount, currency, merchant, category, raw_bank_category,
         status, category_source, source, transaction_date, received_at, categorized_at
       ) VALUES ($1, $2, $3, $4, $5, '', 'categorized', 'user', 'manual', $6, $6, now())
       RETURNING *`,
      [params.userId, params.amount, params.currency, params.merchant, category, params.when],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
