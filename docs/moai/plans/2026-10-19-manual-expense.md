# Manual Expense Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user can add an expense by hand from the dashboard. It is saved as categorized at once and appears everywhere a bank expense appears.

**Architecture:** Migration 007 makes `expenses.webhook_id` nullable, with a `CHECK` that keeps it required for bank rows. A new `createManualExpense()` service and a `POST /api/expenses` route insert the row. A `<dialog>` form in the dashboard calls the route through `apiKeyFetch()`.

**Tech Stack:** Node.js, TypeScript, Express, PostgreSQL (Docker, port 5433), zod, vanilla JS frontend, `node:test` run through `tsx`.

**Spec:** `docs/moai/specs/2026-10-19-manual-expense-design.md`

**Project facts to know first**

- The server runs on port 3001. Start it with `npm run dev`. The API key is `DASHBOARD_API_KEY` in `.env` (example value in `.env.example`: `dev-local-dashboard-key`).
- Docker Desktop was paused when this plan was written. Unpause it, then run `docker compose up -d` from the project folder.
- `npm run migrate` re-runs every `.sql` file and has no tracking table. Do not use it. Apply new migrations with `psql` (Task 2).
- The dev database is shared with the user's own data. Delete test rows by explicit id only, never by time window or merchant.
- There is no test runner yet. This plan adds `node:test` through `tsx` for pure logic, and uses `curl` for the API.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `package.json` | modify | Add `test` script |
| `src/utils/bangkokTime.ts` | modify | Add `resolveManualExpenseDate()` |
| `src/validation/manualExpenseSchema.ts` | create | zod schema for the request body |
| `tests/manualExpense.test.ts` | create | Unit tests for the date helper and schema |
| `migrations/007_manual_expenses.sql` | create | Nullable `webhook_id` and `CHECK` |
| `src/services/categorizationFinalizer.ts` | modify | Export `registerCategory()` |
| `src/services/createManualExpense.ts` | create | Insert the manual expense and register its category |
| `src/routes/expenses.ts` | modify | Add `POST /` |
| `public/index.html` | modify | "Add expense" button and `<dialog>` form |
| `public/style.css` | modify | Dialog and form styles |
| `public/app.js` | modify | Form logic and "Manual" label |

---

### Task 1: Date helper and request schema (unit tested)

**Files:**
- Modify: `package.json`
- Modify: `src/utils/bangkokTime.ts` (append at end)
- Create: `src/validation/manualExpenseSchema.ts`
- Create: `tests/manualExpense.test.ts`

- [ ] **Step 1: Add the test script**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "migrate": "tsx scripts/migrate.ts",
    "mock-bank": "tsx scripts/mockBank.ts",
    "test": "tsx --test tests/*.test.ts"
  },
```

- [ ] **Step 2: Write the failing tests**

Create `tests/manualExpense.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveManualExpenseDate } from '../src/utils/bangkokTime';
import { ManualExpenseRequestSchema } from '../src/validation/manualExpenseSchema';

// 2026-10-19 17:00 in Bangkok (UTC+7)
const NOW = new Date('2026-10-19T10:00:00Z');

describe('resolveManualExpenseDate', () => {
  it('returns now when no date is given', () => {
    assert.equal(resolveManualExpenseDate(undefined, NOW)?.toISOString(), NOW.toISOString());
  });

  it('returns now when the date is today in Bangkok', () => {
    assert.equal(resolveManualExpenseDate('2026-10-19', NOW)?.toISOString(), NOW.toISOString());
  });

  it('uses the Bangkok calendar day, not the UTC day', () => {
    // 2026-10-19 18:00 UTC is already 2026-10-20 01:00 in Bangkok
    const lateUtc = new Date('2026-10-19T18:00:00Z');
    assert.equal(resolveManualExpenseDate('2026-10-20', lateUtc)?.toISOString(), lateUtc.toISOString());
    assert.equal(resolveManualExpenseDate('2026-10-19', lateUtc)?.toISOString(), '2026-10-19T05:00:00.000Z');
  });

  it('stores a past day at 12:00 Bangkok time', () => {
    assert.equal(resolveManualExpenseDate('2026-10-18', NOW)?.toISOString(), '2026-10-18T05:00:00.000Z');
  });

  it('returns null for a future day', () => {
    assert.equal(resolveManualExpenseDate('2026-10-20', NOW), null);
  });
});

describe('ManualExpenseRequestSchema', () => {
  it('accepts a minimal body, trims text and defaults the currency to THB', () => {
    const parsed = ManualExpenseRequestSchema.parse({ merchant: '  Som Tam  ', amount: 65, category: ' Food ' });
    assert.deepEqual(parsed, { merchant: 'Som Tam', amount: 65, category: 'Food', currency: 'THB' });
  });

  it('accepts a date, a lower-case currency and 2 decimal places', () => {
    const parsed = ManualExpenseRequestSchema.parse({
      merchant: 'Cafe',
      amount: 12.5,
      category: 'Food',
      date: '2026-10-01',
      currency: 'usd',
    });
    assert.equal(parsed.date, '2026-10-01');
    assert.equal(parsed.currency, 'USD');
  });

  const base = { merchant: 'Cafe', amount: 10, category: 'Food' };
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['zero amount', { ...base, amount: 0 }],
    ['negative amount', { ...base, amount: -5 }],
    ['3 decimal places', { ...base, amount: 10.123 }],
    ['amount sent as text', { ...base, amount: '10' }],
    ['amount too large', { ...base, amount: 10_000_001 }],
    ['empty merchant', { ...base, merchant: '   ' }],
    ['empty category', { ...base, category: '' }],
    ['category over 40 characters', { ...base, category: 'x'.repeat(41) }],
    ['date in the wrong format', { ...base, date: '19/10/2026' }],
    ['date that does not exist', { ...base, date: '2026-02-31' }],
    ['currency of the wrong length', { ...base, currency: 'BAHT' }],
  ];
  for (const [name, body] of invalid) {
    it(`rejects ${name}`, () => {
      assert.equal(ManualExpenseRequestSchema.safeParse(body).success, false);
    });
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. The error says it cannot find module `../src/validation/manualExpenseSchema` (or that `resolveManualExpenseDate` is not exported).

- [ ] **Step 4: Add the date helper**

Append to `src/utils/bangkokTime.ts`:

```ts

// A manual expense is entered with a Bangkok calendar date (YYYY-MM-DD). Today
// keeps the real time. A past day is stored at 12:00 Bangkok time, so it can
// never slip into the neighbouring day in any chart bucket. A future day
// returns null (the caller answers 400). ISO dates compare correctly as strings.
export function resolveManualExpenseDate(dateKey: string | undefined, now: Date = new Date()): Date | null {
  const todayKey = new Date(now.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
  if (dateKey === undefined || dateKey === todayKey) return now;
  if (dateKey > todayKey) return null;
  return new Date(`${dateKey}T12:00:00+07:00`);
}
```

- [ ] **Step 5: Add the schema**

Create `src/validation/manualExpenseSchema.ts`:

```ts
import { z } from 'zod';

// '2026-02-31' matches the shape but is not a real day. Round-tripping through
// Date catches it, because Date rolls it over to March.
function isRealCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const ManualExpenseRequestSchema = z.object({
  merchant: z.string().trim().min(1).max(100),
  // expenses.amount is NUMERIC(12, 2): 2 decimal places. The tolerance covers
  // binary floating point (12.1 * 100 is 1210.0000000000002).
  amount: z
    .number()
    .positive()
    .max(10_000_000)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, 'At most 2 decimal places'),
  category: z.string().trim().min(1).max(40),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealCalendarDate, 'Not a real calendar date')
    .optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .transform((value) => value.toUpperCase())
    .default('THB'),
});

export type ManualExpenseRequest = z.infer<typeof ManualExpenseRequestSchema>;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with `# pass 18` and `# fail 0` at the end.

- [ ] **Step 7: Commit**

```bash
git add package.json src/utils/bangkokTime.ts src/validation/manualExpenseSchema.ts tests/manualExpense.test.ts
git commit -m "feat: add manual expense schema and date resolution

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration 007

**Files:**
- Create: `migrations/007_manual_expenses.sql`

- [ ] **Step 1: Start the database**

Run: `docker compose up -d && docker compose ps`
Expected: the `postgres` service shows `running`. If Docker says it is "manually paused", ask the user to unpause Docker Desktop from the Whale menu, then run the command again.

- [ ] **Step 2: Write the migration**

Create `migrations/007_manual_expenses.sql`:

```sql
-- Manual expenses have no bank webhook, so webhook_id can be empty.
-- The CHECK keeps the old guarantee for bank rows: they must still link to a webhook.
ALTER TABLE expenses ALTER COLUMN webhook_id DROP NOT NULL;

ALTER TABLE expenses ADD CONSTRAINT expenses_bank_webhook_requires_webhook
  CHECK (source <> 'bank_webhook' OR webhook_id IS NOT NULL);
```

- [ ] **Step 3: Apply it with psql (not `npm run migrate`)**

Run: `docker compose exec -T postgres psql -U expense_tracker -d expense_tracker < migrations/007_manual_expenses.sql`
Expected:

```
ALTER TABLE
ALTER TABLE
```

- [ ] **Step 4: Verify the CHECK rejects a bank row with no webhook**

Run:

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -c "INSERT INTO expenses (user_id, amount, currency, merchant, raw_bank_category, source, transaction_date) VALUES ('check_test', 1, 'THB', 'x', 'x', 'bank_webhook', now());"
```

Expected: `ERROR:  new row for relation "expenses" violates check constraint "expenses_bank_webhook_requires_webhook"`. No row is inserted.

- [ ] **Step 5: Verify existing rows are intact**

Run: `docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -c "SELECT count(*) FROM expenses WHERE webhook_id IS NULL;"`
Expected: `count` is `0`.

- [ ] **Step 6: Commit**

```bash
git add migrations/007_manual_expenses.sql
git commit -m "feat: allow expenses without a webhook for manual entries

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Service that creates a manual expense

**Files:**
- Modify: `src/services/categorizationFinalizer.ts:18` (add `export`)
- Create: `src/services/createManualExpense.ts`

- [ ] **Step 1: Export `registerCategory`**

In `src/services/categorizationFinalizer.ts`, change line 18 from:

```ts
async function registerCategory(client: PoolClient, rawCategory: string): Promise<string> {
```

to:

```ts
export async function registerCategory(client: PoolClient, rawCategory: string): Promise<string> {
```

- [ ] **Step 2: Write the service**

Create `src/services/createManualExpense.ts`:

```ts
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
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/services/categorizationFinalizer.ts src/services/createManualExpense.ts
git commit -m "feat: add createManualExpense service

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /api/expenses` route

**Files:**
- Modify: `src/routes/expenses.ts` (imports at lines 4-8, new route after the `GET /` route that ends at line 144)

- [ ] **Step 1: Add the imports**

In `src/routes/expenses.ts`, after the line `import { CategorizeRequestSchema } from '../validation/categorizeSchema';` add:

```ts
import { ManualExpenseRequestSchema } from '../validation/manualExpenseSchema';
import { createManualExpense } from '../services/createManualExpense';
```

And change the bangkokTime import line to:

```ts
import { bangkokRangeStart, bucketKeys, granularityForRange, isExpenseRange, resolveManualExpenseDate } from '../utils/bangkokTime';
```

- [ ] **Step 2: Add the route**

Insert directly after the `GET /` route (after its closing `);` on line 144), before the "Dashboard Simulate transaction button" comment:

```ts
// Dashboard "Add expense" form: the user types an expense in by hand. It is
// saved as categorized at once, so it never enters the pending tap lane.
expensesRouter.post(
  '/',
  requireApiKey,
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
      userId: DEMO_USER_ID,
      merchant: parsed.data.merchant,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      category: parsed.data.category,
      when,
    });

    res.status(201).json(expense);
  }),
);
```

- [ ] **Step 3: Type-check and make sure the server is running with watch mode**

Run: `npx tsc --noEmit && ps -p $(lsof -tiTCP:3001 -sTCP:LISTEN) -o command=`
Expected: no type errors, then a command containing `tsx watch`. If it shows plain `tsx src/server.ts`, or nothing, stop that process and run `npm run dev` in a separate terminal (a plain `tsx` process does not reload edits).

- [ ] **Step 4: Test the happy path**

Run:

```bash
curl -s -i -X POST http://localhost:3001/api/expenses \
  -H 'Content-Type: application/json' -H 'x-api-key: dev-local-dashboard-key' \
  -d '{"merchant":"PLAN TEST Som Tam","amount":65,"category":"Food"}'
```

Expected: `HTTP/1.1 201 Created` and a JSON body with `"status":"categorized"`, `"source":"manual"`, `"category_source":"user"`, `"category":"Food"`, `"raw_bank_category":""`, `"webhook_id":null`. Write down the returned `id` as `TEST_ID_1`.

- [ ] **Step 5: Test the failure cases**

Run each and compare:

```bash
# no key -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/api/expenses -H 'Content-Type: application/json' -d '{"merchant":"x","amount":1,"category":"Food"}'

# amount 0 -> 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/api/expenses -H 'Content-Type: application/json' -H 'x-api-key: dev-local-dashboard-key' -d '{"merchant":"x","amount":0,"category":"Food"}'

# future date -> 400 with the future-date message
curl -s -X POST http://localhost:3001/api/expenses -H 'Content-Type: application/json' -H 'x-api-key: dev-local-dashboard-key' -d '{"merchant":"x","amount":1,"category":"Food","date":"2099-01-01"}'
```

Expected, in order: `401`, `400`, `{"error":"Date cannot be in the future"}`.

- [ ] **Step 6: Test a backdated expense and a new category**

Run:

```bash
curl -s -X POST http://localhost:3001/api/expenses \
  -H 'Content-Type: application/json' -H 'x-api-key: dev-local-dashboard-key' \
  -d '{"merchant":"PLAN TEST Old Gym","amount":500,"category":"PLAN TEST Health","date":"2026-10-01"}'
```

Expected: `201`, `"received_at":"2026-10-01T05:00:00.000Z"` and `"transaction_date":"2026-10-01T05:00:00.000Z"`. Write down the `id` as `TEST_ID_2`.

Then run: `curl -s http://localhost:3001/api/categories`
Expected: the list now includes `PLAN TEST Health`.

Then check range filtering. Run:

```bash
curl -s 'http://localhost:3001/api/expenses?range=week' | grep -c 'PLAN TEST Old Gym'
curl -s 'http://localhost:3001/api/expenses?range=month' | grep -c 'PLAN TEST Old Gym'
```

Expected: `0` for the week range, `1` for the month range (today is 2026-10-19, so 2026-10-01 is 18 days back: inside the 30-day month window, outside the 7-day week window). If today's date has moved on a lot since this plan was written, pick a date that fits the same check.

- [ ] **Step 7: Clean up the test data by explicit id and category name**

Run (replace the ids with `TEST_ID_1` and `TEST_ID_2`):

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -c "DELETE FROM expenses WHERE id IN (<TEST_ID_1>, <TEST_ID_2>) AND merchant LIKE 'PLAN TEST%';"
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -c "DELETE FROM categories WHERE name = 'PLAN TEST Health' AND is_default = false;"
```

Expected: `DELETE 2`, then `DELETE 1`.

- [ ] **Step 8: Commit**

```bash
git add src/routes/expenses.ts
git commit -m "feat: add POST /api/expenses for manual entries

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Dashboard form

**Files:**
- Modify: `public/index.html` (header button at line 22, dialog before the script tag at line 79)
- Modify: `public/style.css` (append at end)
- Modify: `public/app.js` (element refs near line 108, `bindNode` at lines 355-391, new section before the `// Self-rescheduling setTimeout` comment at line 959)

The form lives in a `<dialog>`, outside `#expense-list`. The 3 second auto-refresh rebuilds only the list and pending lane, so it cannot wipe the form (the Session 8 bug).

- [ ] **Step 1: Add the button**

In `public/index.html`, add this line directly before the `simulate-btn` button:

```html
        <button id="add-btn" class="btn" type="button">Add expense</button>
```

- [ ] **Step 2: Add the dialog**

In `public/index.html`, insert before `<script src="app.js"></script>`:

```html
  <dialog id="add-dialog" class="add-dialog" aria-labelledby="add-title">
    <form id="add-form" novalidate>
      <h2 id="add-title">Add expense</h2>
      <label class="field">Merchant
        <input id="add-merchant" type="text" maxlength="100" autocomplete="off" required />
      </label>
      <label class="field">Amount (THB)
        <input id="add-amount" type="number" inputmode="decimal" min="0.01" step="0.01" required />
      </label>
      <fieldset class="field">
        <legend>Category</legend>
        <div id="add-categories" class="add-categories"></div>
        <input id="add-new-category" type="text" maxlength="40" placeholder="New category name" autocomplete="off" hidden />
      </fieldset>
      <label class="field">Date
        <input id="add-date" type="date" required />
      </label>
      <p id="add-error" class="add-error" role="alert" hidden></p>
      <div class="add-actions">
        <button id="add-cancel" class="btn-quiet" type="button">Cancel</button>
        <button id="add-save" class="btn" type="submit">Save</button>
      </div>
    </form>
  </dialog>
```

- [ ] **Step 3: Add the styles**

Append to `public/style.css`:

```css

/* ---------- add expense dialog ---------- */
.add-dialog {
  border: 1px solid var(--line-strong); border-radius: 12px; padding: 20px;
  background: var(--surface); color: var(--ink); width: min(420px, calc(100vw - 32px));
}
.add-dialog::backdrop { background: rgba(42, 27, 45, 0.45); }
.add-dialog h2 { margin: 0 0 14px; font-size: 1.1rem; }
.field { display: block; margin: 0 0 14px; padding: 0; border: 0; font-size: 0.85rem; color: var(--muted); }
.field legend { padding: 0; margin-bottom: 6px; }
.field input[type="text"], .field input[type="number"], .field input[type="date"] {
  display: block; width: 100%; margin-top: 4px; padding: 8px 10px; font: inherit; color: var(--ink);
  border: 1px solid var(--line-strong); border-radius: 8px; background: var(--paper);
}
.add-categories { display: flex; flex-wrap: wrap; gap: 6px; }
.add-categories .category-pill[aria-pressed="true"] { border-color: var(--ink); background: var(--paper); font-weight: 500; }
#add-new-category { margin-top: 8px; }
.add-error { margin: 0 0 12px; color: var(--pink); font-size: 0.85rem; }
.add-actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 4: Add the "Manual" label to ledger rows**

In `public/app.js`, in `bindNode`, change the signature line from:

```js
      : `${item.key}|${item.expanded}|${item.expense.category}|${item.expense.amount}|${allCategories.map((c) => c.name).join(',')}`;
```

to:

```js
      : `${item.key}|${item.expanded}|${item.expense.category}|${item.expense.amount}|${item.expense.source}|${allCategories.map((c) => c.name).join(',')}`;
```

And change the meta line from:

```js
        <span aria-hidden="true">&middot;</span> ${formatTime(e.received_at)}</div>
```

to:

```js
        <span aria-hidden="true">&middot;</span> ${e.source === 'manual' ? 'Manual' : formatTime(e.received_at)}</div>
```

(A past manual expense is stored at 12:00, which is not a real time. "Manual" is the honest label.)

- [ ] **Step 5: Add the element references**

In `public/app.js`, directly after the line `const simulateBtnEl = $('simulate-btn');` add:

```js
const addBtnEl = $('add-btn');
const addDialogEl = $('add-dialog');
const addFormEl = $('add-form');
const addMerchantEl = $('add-merchant');
const addAmountEl = $('add-amount');
const addCategoriesEl = $('add-categories');
const addNewCategoryEl = $('add-new-category');
const addDateEl = $('add-date');
const addErrorEl = $('add-error');
const addSaveEl = $('add-save');
```

- [ ] **Step 6: Add the form logic**

In `public/app.js`, insert before the comment `// Self-rescheduling setTimeout, not setInterval:`:

```js
// ---------- add expense (manual entry) ----------

let addSelectedCategory = '';

function showAddError(message) {
  addErrorEl.textContent = message;
  addErrorEl.hidden = !message;
}

// Category chips come from the master list, plus "+ New" for a name that does
// not exist yet. Built once per open, not on every refresh tick.
function renderAddCategories() {
  addCategoriesEl.innerHTML = '';
  const choices = [...allCategories.map((c) => ({ value: c.name, label: c.name, color: c.color })), { value: CUSTOM_PILL, label: '+ New', color: null }];
  for (const choice of choices) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'category-pill';
    btn.dataset.value = choice.value;
    btn.setAttribute('aria-pressed', String(choice.value === addSelectedCategory));
    btn.innerHTML = `${choice.color ? `<span class="dot" style="background:${choice.color}"></span>` : ''}${escapeHtml(choice.label)}`;
    btn.addEventListener('click', () => {
      addSelectedCategory = choice.value;
      addNewCategoryEl.hidden = choice.value !== CUSTOM_PILL;
      if (choice.value === CUSTOM_PILL) addNewCategoryEl.focus();
      addCategoriesEl.querySelectorAll('.category-pill').forEach((p) => {
        p.setAttribute('aria-pressed', String(p.dataset.value === addSelectedCategory));
      });
    });
    addCategoriesEl.appendChild(btn);
  }
}

function openAddDialog() {
  addFormEl.reset();
  addSelectedCategory = '';
  addNewCategoryEl.hidden = true;
  showAddError('');
  const today = bangkokDayKey(new Date().toISOString());
  addDateEl.value = today;
  addDateEl.max = today;
  renderAddCategories();
  addDialogEl.showModal();
  addMerchantEl.focus();
}

addBtnEl.addEventListener('click', openAddDialog);
$('add-cancel').addEventListener('click', () => addDialogEl.close());

addFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const merchant = addMerchantEl.value.trim();
  const amount = Number(addAmountEl.value);
  const category = addSelectedCategory === CUSTOM_PILL ? addNewCategoryEl.value.trim() : addSelectedCategory;

  if (!merchant) return showAddError('Enter the merchant.');
  if (!(amount > 0)) return showAddError('Enter an amount greater than 0.');
  if (!category) return showAddError('Choose a category.');
  if (!addDateEl.value) return showAddError('Choose a date.');
  showAddError('');

  addSaveEl.disabled = true;
  try {
    const res = await apiKeyFetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant, amount, category, date: addDateEl.value }),
    });
    if (res.status === 401) throw new Error('The API key was not accepted. Try again.');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error === 'Date cannot be in the future' ? 'The date cannot be in the future.' : 'The expense was not saved. Check the values and try again.');
    }
    addDialogEl.close();
    statusEl.textContent = `Added ${merchant}`;
    await refreshCategories();
    await refresh();
  } catch (err) {
    console.error(err);
    showAddError(err.message);
  } finally {
    addSaveEl.disabled = false;
  }
});

```

Note: `refreshCategories()` calls `renderManageCategories()`, which touches only the manage panel, not the dialog.

- [ ] **Step 7: Verify in the browser**

Ask the user to hard-refresh the dashboard (an old tab with old JavaScript is a repeated problem in this project). Use the Chrome tools if they are connected. Check each item:

1. The "Add expense" button is in the header. Clicking it opens the dialog with today's date filled in and no category selected.
2. Saving with an empty field shows the matching inline message and the dialog stays open.
3. Wait 10 seconds with the dialog open and text typed in. The text is still there (auto-refresh runs every 3 seconds).
4. Add `PLAN TEST Lunch`, 85, category Food, today. The dialog closes, and the row appears at the top of today's group with the "Manual" label. The overview total and the "Where it went" chart update.
5. Add `PLAN TEST Gym`, 500, the "+ New" category `PLAN TEST Sport`, a date 3 days ago. It appears under that day, and `PLAN TEST Sport` appears in the category filter and in "Manage categories".
6. Select the Week range. Both rows show. Select Day. Only the first shows.
7. Click "Download CSV". The file includes both rows, with the right dates in Bangkok time.
8. The date picker does not allow a day after today.

- [ ] **Step 8: Clean up test data by explicit id**

Find the ids: `curl -s 'http://localhost:3001/api/expenses?range=week' | grep -o '"id":"[0-9]*","user_id":"[^"]*","amount":"[^"]*","currency":"[^"]*","merchant":"PLAN TEST[^"]*"'`
Then delete by id only, and remove the test category (replace `<ID_A>` and `<ID_B>`):

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -c "DELETE FROM expenses WHERE id IN (<ID_A>, <ID_B>) AND merchant LIKE 'PLAN TEST%';"
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -c "DELETE FROM categories WHERE name = 'PLAN TEST Sport' AND is_default = false;"
```

Expected: `DELETE 2`, then `DELETE 1`.

- [ ] **Step 9: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "feat: add manual expense form to the dashboard

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Final check and project notes

**Files:**
- Modify: `/Users/lim/.claude/projects/-Users-lim-Desktop-web-programming-expense-tracker/memory/project_expense_webhook_diagrams.md`
- Modify: `README.md` (only if it lists the API routes or features)

- [ ] **Step 1: Run the full checks**

Run: `npm test && npx tsc --noEmit`
Expected: all 18 tests pass, no type errors.

- [ ] **Step 2: Confirm the bank flow still works**

Run: `npm run mock-bank`
Expected: the script reports a successful webhook (`200`/`201`) and the new pending row shows in the dashboard "Needs a tap" lane. This proves migration 007 did not break bank ingestion. Delete that test row by its id only (the `expense_id` printed by the script), or tap it into a category if the user prefers to keep it.

- [ ] **Step 3: Check the README**

Run: `grep -n -i "api/expenses\|simulate\|feature" README.md`
If the README lists endpoints or features, add one line for `POST /api/expenses` (manual entry, needs the `x-api-key` header). If it lists neither, change nothing.

- [ ] **Step 4: Update the project memory**

Append a "Session 11" entry to the project memory file (user preference: keep memory current each session, see `feedback_session_continuity.md`). Record: the manual entry feature, migration 007 and why it was applied with `psql`, that list filters use `received_at` (so manual rows set both dates), the "Manual" label replacing the time, the new `npm test` runner (`node:test` through `tsx`), and that manual entries do not teach merchant rules by the user's choice.

- [ ] **Step 5: Commit the README change, if any**

```bash
git add README.md
git commit -m "docs: mention manual expense endpoint

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

If the README did not change, skip this step.

---

## Self-review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Migration 007, nullable `webhook_id`, `CHECK` | 2 |
| `POST /api/expenses`, zod rules | 1 (schema), 4 (route) |
| Auth with `requireApiKey` and `apiKeyFetch` | 4, 5 |
| Insert values (`categorized`, `user`, `manual`, dates) | 3 |
| Date resolution (today, past at 12:00, future rejected) | 1, 4 |
| Category registered in the same transaction | 3 |
| No merchant rules, no push | 3 (by omission, stated in the comment) |
| Form with merchant, amount, category chips, date | 5 |
| Form survives auto-refresh | 5 (dialog outside the list, step 7 check 3) |
| "Manual" label | 5 |
| Tests listed in the spec | 1, 2, 4, 5, 6 |

**Placeholder scan:** the only angle-bracket values are `<TEST_ID_1>`, `<TEST_ID_2>`, `<ID_A>`, `<ID_B>`. These are ids the engineer reads from earlier output, and each step says where they come from.

**Type consistency:** `resolveManualExpenseDate` (Task 1) is used in Task 4 with the same name and signature. `ManualExpenseRequestSchema` fields (`merchant`, `amount`, `category`, `date`, `currency`) match the route and the form body. `createManualExpense` params (`userId`, `merchant`, `amount`, `currency`, `category`, `when`) match the route call. `registerCategory` is exported in Task 3 before it is imported.
