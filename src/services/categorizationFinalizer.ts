import type { Pool } from 'pg';
import type { CategorySource } from '../types/webhook';
import { colorForCategoryName } from './categoryColor';

export interface FinalizeResult {
  applied: boolean;
  expenseId: number;
  /** The canonical category name actually stored (see note on case-folding below). */
  category?: string;
}

/**
 * Finalizes a pending expense's category. Guarded by `WHERE status = 'pending'` so
 * whichever caller gets here first (a user tap, or the timeout sweep) wins the race —
 * the loser's UPDATE just affects zero rows instead of overwriting the winner.
 */
export async function finalizeCategory(
  pool: Pool,
  expenseId: number,
  rawCategory: string,
  source: Exclude<CategorySource, null>,
): Promise<FinalizeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Register the category (or reuse an existing one that only differs in
    // case/whitespace, e.g. "food" vs "Food") so it shows up as a quick-pick
    // option and in the filter dropdown — covers both a fresh custom name
    // typed via the tap UI and the mapping's fallback category from the
    // timeout sweep. The categories_name_lower_idx unique index makes this
    // atomic under concurrent first-time inserts of the same name.
    const trimmedCategory = rawCategory.trim();
    const categoryResult = await client.query(
      `INSERT INTO categories (name, color)
       VALUES ($1, $2)
       ON CONFLICT (lower(trim(name))) DO UPDATE SET name = categories.name
       RETURNING name`,
      [trimmedCategory, colorForCategoryName(trimmedCategory)],
    );
    const category = categoryResult.rows[0].name as string;

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
    return { applied: true, expenseId, category };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
