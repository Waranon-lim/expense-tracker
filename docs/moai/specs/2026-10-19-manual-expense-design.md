# Manual expense entry: design

Date: 2026-10-19

## Goal

The user can add an expense by hand, like in a normal expense app. The expense is saved as categorized at once and appears in the list, charts, summary and CSV export with no other change.

## Decisions

| Topic | Decision |
|---|---|
| Category | The user picks it in the form. No "Needs a tap" lane for manual entries. |
| Storage | `expenses.webhook_id` becomes nullable. Manual rows have `source = 'manual'` and no webhook. |
| Merchant rules | Manual entries do not teach merchant rules. |
| Push notification | None. The user made the entry. |
| Category list | A new category from the form is added to `categories` (permanent choice), as `finalizeCategory()` does. |

## Backend

### Migration 007

- `ALTER TABLE expenses ALTER COLUMN webhook_id DROP NOT NULL`.
- Add `CHECK (source <> 'bank_webhook' OR webhook_id IS NOT NULL)`, so a bank row can never lose its webhook link.
- Apply directly with `psql`, because `npm run migrate` re-runs every file and has no tracking table.

### Endpoint

`POST /api/expenses` in `src/routes/expenses.ts`, registered before `/:id`.

Input (zod schema in `src/validation/`):

| Field | Rule |
|---|---|
| `merchant` | Required. Trimmed. 1 to 100 characters. |
| `amount` | Required. Greater than 0. At most 2 decimal places. |
| `category` | Required. Trimmed. 1 to 50 characters. |
| `date` | Optional ISO date. Default: now. Not in the future. |
| `currency` | Optional. Default `THB`. Three letters. |

The client does not send a user id. The server sets `user_id` to `DEMO_USER_ID` (from `src/constants.ts`), as every other expense route does.

The insert sets:

- `status = 'categorized'`
- `category_source = 'user'`
- `source = 'manual'`
- `raw_bank_category = ''`
- `transaction_date = date`
- `categorized_at = now()`

The category insert into `categories` (`ON CONFLICT (name) DO NOTHING`) runs in the same transaction as the expense insert.

Responses: `201` with the new expense, `400` with zod errors.

A small service, `src/services/createManualExpense.ts`, holds the insert. The route stays thin, like `ingestTransaction()`.

## Frontend

- An "Add expense" button in the header opens a form with: merchant, amount, category chips (from `allCategories`, plus a custom option), and date (default today, Bangkok time).
- On save the form closes and the list refreshes.
- Manual rows show a small "Manual" label.
- The form sits outside the element that `renderList()` rebuilds, so the 3 second auto-refresh cannot wipe it (the Session 8 bug).
- Errors from the API show inside the form.

## Testing

- Create a manual expense with `curl`: row is `categorized`, `source = 'manual'`, `category_source = 'user'`.
- Invalid input returns `400`: amount 0, negative amount, empty merchant, future date.
- A new category name appears in `GET /api/categories`.
- The expense appears in `GET /api/expenses`, in the summary total, and in the CSV export.
- A bank webhook insert still works after migration 007.
- A direct insert with `source = 'bank_webhook'` and no `webhook_id` is rejected by the `CHECK` constraint.
- Browser check: the form survives several auto-refresh cycles.

## Out of scope

Edit and delete of manual rows, a note field, recurring expenses, receipt photos, and learning merchant rules from manual entries. Each can be a later step.
