import type { Pool } from 'pg';
import { loadMerchantRules, suggestCategory } from '../services/merchantRules';
import { finalizeCategory } from '../services/categorizationFinalizer';

interface PendingExpenseRow {
  id: number;
  user_id: string;
  raw_bank_category: string;
  merchant: string;
}

async function sweepOnce(pool: Pool, timeoutMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - timeoutMs);

  const { rows } = await pool.query<PendingExpenseRow>(
    `SELECT id, user_id, raw_bank_category, merchant
     FROM expenses
     WHERE status = 'pending' AND received_at <= $1`,
    [cutoff],
  );

  const rulesByUser = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (!rulesByUser.has(row.user_id)) rulesByUser.set(row.user_id, await loadMerchantRules(pool, row.user_id));
    const { category, source } = suggestCategory(rulesByUser.get(row.user_id)!, row.merchant, row.raw_bank_category);
    // The DB's category_source only allows user/default/mapping; a learned
    // rule is still the app's own (non-tap) decision, so it files as 'mapping'.
    const { applied } = await finalizeCategory(pool, row.id, category, source === 'default' ? 'default' : 'mapping');
    if (applied) {
      console.log(`[categorization-sweep] expense ${row.id} timed out -> "${category}" (${source})`);
    }
  }
}

export interface CategorizationSweepHandle {
  stop: () => void;
}

/**
 * Self-rescheduling timeout loop, NOT setInterval. setInterval fires on a fixed
 * clock regardless of whether the previous tick's async work finished — if
 * sweepOnce() ever takes longer than intervalMs, the next tick starts while the
 * last one is still running, and overlaps compound if the DB stays slow. Waiting
 * to schedule the next run until the current one settles guarantees at most one
 * sweep in flight at a time, at the cost of a small amount of timing precision
 * (the real period becomes intervalMs + however long the sweep took).
 */
export function startCategorizationSweep(
  pool: Pool,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): CategorizationSweepHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    try {
      await sweepOnce(pool, timeoutMs);
    } catch (err) {
      console.error('[categorization-sweep] sweep failed:', err);
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
      }
    }
  };

  timer = setTimeout(tick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
