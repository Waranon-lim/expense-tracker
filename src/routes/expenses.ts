import crypto from 'node:crypto';
import { Router } from 'express';
import { pool } from '../db/pool';
import { CategorizeRequestSchema } from '../validation/categorizeSchema';
import { ManualExpenseRequestSchema } from '../validation/manualExpenseSchema';
import { createManualExpense } from '../services/createManualExpense';
import { finalizeCategory, recategorizeExpense } from '../services/categorizationFinalizer';
import { loadMerchantRules, suggestCategory } from '../services/merchantRules';
import { ingestTransaction } from '../services/ingestTransaction';
import { bangkokRangeStart, bucketKeys, granularityForRange, isExpenseRange, resolveManualExpenseDate } from '../utils/bangkokTime';
import { asyncHandler } from '../utils/asyncHandler';
import { requireUser } from '../middleware/requireUser';
import { verifyNotificationToken } from '../services/pushNotifications';
import { categorizationTimeoutMs } from '../constants';

export const expensesRouter = Router();

// Escapes ILIKE wildcard metacharacters so a merchant search for a literal
// '%' or '_' doesn't get treated as a pattern wildcard by Postgres.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Random merchants for the dashboard's "Simulate transaction" button — each
// bank_category is chosen so mapBankCategory() genuinely produces a sensible
// suggestion for that merchant, same as a real bank webhook would.
const SIMULATED_MERCHANTS = [
  { merchant: 'STARBUCKS STORE 101', bankCategory: 'STARBUCKS_STORE_101', minAmount: 60, maxAmount: 180 },
  { merchant: 'GRAB', bankCategory: 'GRAB_RIDE', minAmount: 40, maxAmount: 200 },
  { merchant: 'UBER', bankCategory: 'UBER_TRIP', minAmount: 50, maxAmount: 250 },
  { merchant: '7-ELEVEN', bankCategory: 'SHOPPING', minAmount: 20, maxAmount: 150 },
  { merchant: "MCDONALD'S", bankCategory: 'MCDONALDS', minAmount: 80, maxAmount: 220 },
  { merchant: 'BTS SKYTRAIN', bankCategory: 'TRANSPORTATION', minAmount: 20, maxAmount: 60 },
  { merchant: 'NETFLIX', bankCategory: 'ENTERTAINMENT', minAmount: 200, maxAmount: 450 },
  { merchant: "LOTUS'S", bankCategory: 'GROCERY', minAmount: 150, maxAmount: 900 },
  { merchant: 'CENTRAL DEPARTMENT STORE', bankCategory: 'SHOPPING', minAmount: 300, maxAmount: 2500 },
];

function randomAmount(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

function parseListFilters(req: import('express').Request) {
  const range = isExpenseRange(req.query.range) ? req.query.range : 'day';
  const rangeStart = bangkokRangeStart(range);
  const category = typeof req.query.category === 'string' && req.query.category.length > 0 ? req.query.category : null;
  const q = typeof req.query.q === 'string' && req.query.q.trim().length > 0 ? escapeLikePattern(req.query.q.trim()) : null;
  return { range, rangeStart, category, q };
}

// Shared by the list/summary/top-category queries below so the filter logic
// only has to be right — and changed — in one place.
const LIST_FILTER_WHERE = `
  user_id = $1
  AND received_at >= $2
  AND ($3::text IS NULL OR category = $3)
  AND ($4::text IS NULL OR merchant ILIKE '%' || $4 || '%' ESCAPE '\\')
`;

expensesRouter.get(
  '/',
  requireUser,
  asyncHandler(async (req, res) => {
    const { range, rangeStart, category, q } = parseListFilters(req);
    const params = [req.userId, rangeStart, category, q];
    const granularity = granularityForRange(range);
    const bucketFormat = { hour: 'YYYY-MM-DD"T"HH24', day: 'YYYY-MM-DD', month: 'YYYY-MM' }[granularity];

    const [result, summaryResult, topCategoryResult, bucketResult, byCategoryResult] = await Promise.all([
      pool.query(
        `SELECT * FROM expenses
         WHERE ${LIST_FILTER_WHERE}
         ORDER BY received_at DESC
         LIMIT 200`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0) AS total
         FROM expenses
         WHERE ${LIST_FILTER_WHERE}`,
        params,
      ),
      pool.query(
        `SELECT category, SUM(amount) AS total
         FROM expenses
         WHERE ${LIST_FILTER_WHERE}
           AND category IS NOT NULL
         GROUP BY category
         ORDER BY total DESC
         LIMIT 1`,
        params,
      ),
      // Spend over time for the bar chart. Grouped in Bangkok wall-clock time
      // (AT TIME ZONE) so "today" matches what the rest of the app means.
      pool.query(
        `SELECT to_char(received_at AT TIME ZONE 'Asia/Bangkok', '${bucketFormat}') AS bucket,
                SUM(amount) AS total
         FROM expenses
         WHERE ${LIST_FILTER_WHERE}
         GROUP BY bucket`,
        params,
      ),
      pool.query(
        `SELECT COALESCE(category, 'Pending') AS category, SUM(amount) AS total, COUNT(*)::int AS count
         FROM expenses
         WHERE ${LIST_FILTER_WHERE}
         GROUP BY 1
         ORDER BY total DESC`,
        params,
      ),
    ]);

    const totalsByBucket = new Map<string, number>(bucketResult.rows.map((r) => [r.bucket as string, Number(r.total)]));
    const buckets = bucketKeys(rangeStart, granularity).map((key) => ({ key, total: totalsByBucket.get(key) ?? 0 }));

    // suggested_category isn't persisted for pending rows (only computed at
    // webhook time and thrown away) so recompute it here for display.
    const rules = await loadMerchantRules(pool, req.userId);
    const expenses = result.rows.map((row) => {
      if (row.status !== 'pending') {
        return row;
      }
      const { category: suggested_category, source } = suggestCategory(rules, row.merchant, row.raw_bank_category);
      return { ...row, suggested_category, suggestion_source: source };
    });

    res.status(200).json({
      expenses,
      timeoutMs: categorizationTimeoutMs(),
      serverNow: new Date().toISOString(),
      chart: {
        granularity,
        buckets,
        byCategory: byCategoryResult.rows.map((r) => ({
          category: r.category as string,
          total: Number(r.total),
          count: r.count as number,
        })),
      },
      summary: {
        total: Number(summaryResult.rows[0].total),
        count: summaryResult.rows[0].count as number,
        topCategory: (topCategoryResult.rows[0]?.category as string) ?? null,
      },
    });
  }),
);

// Dashboard "Add expense" form: the user types an expense in by hand. It is
// saved as categorized at once, so it never enters the pending tap lane.
expensesRouter.post(
  '/',
  requireUser,
  asyncHandler(async (req, res) => {
    const parsed = ManualExpenseRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const when = resolveManualExpenseDate(parsed.data.date);
    if (!when) {
      res.status(400).json({ error: 'Date cannot be in the future' });
      return;
    }

    const expense = await createManualExpense(pool, {
      userId: req.userId,
      merchant: parsed.data.merchant,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      category: parsed.data.category,
      when,
    });

    res.status(201).json(expense);
  }),
);

// Dashboard "Simulate transaction" button: creates a pending expense for a
// random merchant, same code path as a real bank webhook (ingestTransaction),
// so it goes through the same pending -> tap-or-timeout-sweep flow.
expensesRouter.post(
  '/simulate',
  requireUser,
  asyncHandler(async (req, res) => {
    const pick = SIMULATED_MERCHANTS[Math.floor(Math.random() * SIMULATED_MERCHANTS.length)];
    const amount = randomAmount(pick.minAmount, pick.maxAmount);

    const result = await ingestTransaction(pool, {
      provider: 'ui_simulator',
      providerTransactionId: `sim_${crypto.randomUUID()}`,
      userId: req.userId,
      amount,
      currency: 'THB',
      merchantName: pick.merchant,
      bankCategory: pick.bankCategory,
      timestamp: new Date().toISOString(),
    });

    if (result.duplicate) {
      // Practically unreachable (provider_transaction_id is a fresh UUID every call).
      res.status(409).json({ error: 'Duplicate transaction, try again' });
      return;
    }

    res.status(201).json({
      expense_id: result.expenseId,
      merchant: pick.merchant,
      amount,
      suggested_category: result.suggestedCategory,
    });
  }),
);

expensesRouter.get(
  '/:id',
  requireUser,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid expense id' });
      return;
    }

    const result = await pool.query('SELECT * FROM expenses WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }

    res.status(200).json(result.rows[0]);
  }),
);

// Simulates the user tapping a category on the push-notification prompt.
expensesRouter.post(
  '/:id/categorize',
  requireUser,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid expense id' });
      return;
    }

    const parseResult = CategorizeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Invalid request', details: parseResult.error.flatten() });
      return;
    }

    const { applied, category } = await finalizeCategory(pool, id, parseResult.data.category, 'user');

    if (!applied) {
      const existing = await pool.query('SELECT status FROM expenses WHERE id = $1 AND user_id = $2', [id, req.userId]);
      if (existing.rowCount === 0) {
        res.status(404).json({ error: 'Expense not found' });
        return;
      }
      res.status(409).json({ error: 'Expense is already categorized' });
      return;
    }

    res.status(200).json({ status: 'categorized', category });
  }),
);

// Changes the category of an already-filed expense (the "Change" link in the
// dashboard). 404 covers both "no such expense" and "still pending" — a
// pending one is changed through the normal tap route instead.
expensesRouter.patch(
  '/:id/category',
  requireUser,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid expense id' });
      return;
    }
    const parsed = CategorizeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    const { applied, category } = await recategorizeExpense(pool, id, req.userId, parsed.data.category);
    if (!applied) {
      res.status(404).json({ error: 'No filed expense with that id' });
      return;
    }
    res.status(200).json({ status: 'categorized', category });
  }),
);

// Called by the phone notification's buttons (from the service worker, which has
// no API key). Authorized instead by the per-expense token that came in the push.
expensesRouter.post(
  '/:id/categorize-from-notification',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const token = req.header('x-notification-token') ?? '';
    console.log(`[push] categorize-from-notification expense=${req.params.id} tokenValid=${verifyNotificationToken(id, token)}`);
    if (!Number.isInteger(id) || !verifyNotificationToken(id, token)) {
      res.status(401).json({ error: 'Invalid notification token' });
      return;
    }
    const parsed = CategorizeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { applied, category } = await finalizeCategory(pool, id, parsed.data.category, 'user', req.userId);
    if (!applied) {
      res.status(409).json({ error: 'Expense is already categorized' });
      return;
    }
    res.status(200).json({ status: 'categorized', category });
  }),
);
