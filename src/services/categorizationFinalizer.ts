import type { Pool, PoolClient } from 'pg';
import type { CategorySource } from '../types/webhook';
import { colorForCategoryName } from './categoryColor';
import { learnMerchantRule } from './merchantRules';

export interface FinalizeResult {
  applied: boolean;
  expenseId: number;
  /** The canonical category name actually stored (see note on case-folding below). */
  category?: string;
}


// Registers the category (or reuses one that only differs in case/whitespace,
// e.g. "food" vs "Food") so it shows up as a quick-pick option and in the
// filter dropdown. The categories_name_lower_idx unique index makes this
// atomic under concurrent first-time inserts of the same name.
async function registerCategory(client: PoolClient, rawCategory: string): Promise<string> {
  const trimmedCategory = rawCategory.trim();
  const result = await client.query(
    `INSERT INTO categories (name, color)
     VALUES ($1, $2)
     ON CONFLICT (lower(trim(name))) DO UPDATE SET name = categories.name
     RETURNING name`,
    [trimmedCategory, colorForCategoryName(trimmedCategory)],
  );
  return result.rows[0].name as string;
}

/**
 * Changes the category of an expense that was ALREADY filed (by a tap or by the
 * timeout). Only this one expense changes; other past payments from the same
 * merchant keep their category. It also teaches the merchant rule, since an
 * explicit correction is the strongest signal the user can give.
 */
export async function recategorizeExpense(
  pool: Pool,
  expenseId: number,
  userId: string,
  rawCategory: string,
): Promise<{ applied: boolean; category?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const category = await registerCategory(client, rawCategory);
    const result = await client.query(
      `UPDATE expenses
       SET category = $1, category_source = 'user', updated_at = now()
       WHERE id = $2 AND user_id = $3 AND status = 'categorized'
       RETURNING merchant`,
      [category, expenseId, userId],
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { applied: false };
    }
    await learnMerchantRule(client, userId, result.rows[0].merchant as string, category);
    await client.query('COMMIT');
    return { applied: true, category };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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

    const category = await registerCategory(client, rawCategory);

    const expenseResult = await client.query(
      `UPDATE expenses
       SET category = $1, status = 'categorized', category_source = $2,
           categorized_at = now(), updated_at = now()
       WHERE id = $3 AND status = 'pending'
       RETURNING webhook_id, user_id, merchant`,
      [category, source, expenseId],
    );

    if (expenseResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { applied: false, expenseId };
    }

    const webhookId = expenseResult.rows[0].webhook_id as number;

    // Only a human choice teaches the app. A timeout fill is the app's own
    // guess, and learning from it would just reinforce that guess.
    if (source === 'user') {
      await learnMerchantRule(client, expenseResult.rows[0].user_id as string, expenseResult.rows[0].merchant as string, category);
    }

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
