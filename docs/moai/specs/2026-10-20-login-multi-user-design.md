# Login and multiple users: design

Date: 2026-10-20

## Roadmap context

This is step A of five. Order: A login and multiple users, B edit and delete expenses, C income and balance, D budgets and alerts, E period comparison. Each step has its own spec, plan and build. Step A comes first so every later feature is per-user from the start.

## Goal

People sign in with email and password. Each user sees only their own expenses, categories, learned rules and phone alerts. The fixed demo user and the shared API key go away.

## Decisions

| Topic | Decision |
|---|---|
| Sign-in method | Email and password. The app stores its own accounts. |
| Session | Server-side sessions. A random token in an `HttpOnly` cookie. The database stores only the token hash. |
| Remember me | Checked: cookie and session last 30 days. Not checked: cookie ends when the browser closes, server-side expiry is 12 hours. |
| Password hashing | Node `crypto.scrypt`, a random 16-byte salt per hash, compared with `timingSafeEqual`. Minimum 8 characters. Same password gives a different hash for each user. |
| Sign-up | Open. `ALLOW_SIGNUP=false` in `.env` closes it. Sign-up always works while there are zero users. |
| Existing data | The first account gets the id `usr_demo_1`, so all existing rows already belong to it. No row moves. |
| Categories | Per user. New accounts get Food, Transport and Other as defaults. |
| Bank webhooks | The payload `user_id` must match a user id. An unknown id gets `404` and nothing is stored. |
| New packages | None. Cookie parsing and the rate limiter are small local helpers. |
| Phone-alert token secret | A new `NOTIFICATION_SECRET` setting in `.env` replaces `DASHBOARD_API_KEY` as the key that signs the per-expense alert token. |
| Pure session helpers | `src/services/sessionToken.ts` holds the token functions that need no database, so they have unit tests. |

## Database

### Migration 008

- `users`: `id TEXT PRIMARY KEY`, `email TEXT NOT NULL`, `password_hash TEXT NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. A unique index on `lower(email)`.
- `sessions`: `token_hash TEXT PRIMARY KEY`, `user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `expires_at TIMESTAMPTZ NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. An index on `user_id`.
- `categories`: add `user_id TEXT`. Set it to `usr_demo_1` for every existing row, then make it `NOT NULL`. Drop the global unique constraint on `name` (`categories_name_key`) and the global index `categories_name_lower_idx`. Create a unique index on `(user_id, lower(trim(name)))`.
- No foreign key from `expenses`, `merchant_rules` or `push_subscriptions` to `users`. Rows already exist for ids that may not have an account, and bank webhooks decide their own user ids.
- Apply with `psql`, not `npm run migrate` (it re-runs every file and has no tracking table).

### Password hash format

`scrypt$<salt hex>$<hash hex>`. The salt is new for every hash, so two users with the same password get different strings. Verification reads the salt from the string.

### Session token

32 random bytes, base64url, sent to the browser. The database stores `sha256(token)` as hex. A leaked database does not give out working sessions.

## Backend

### New files

| File | Responsibility |
|---|---|
| `src/services/passwordHash.ts` | `hashPassword()`, `verifyPassword()` |
| `src/services/sessions.ts` | Create, look up and delete sessions. Expiry rules. Delete expired rows at each login. |
| `src/services/users.ts` | Create a user (first user gets `usr_demo_1`, later users get `usr_<8 random hex>`), find by email, seed default categories for a new user. |
| `src/utils/cookies.ts` | Parse the `Cookie` header, build `Set-Cookie` strings. |
| `src/utils/loginRateLimit.ts` | In-memory failed-attempt counter. |
| `src/middleware/requireUser.ts` | Reads the cookie, finds the session, sets `req.userId`, or answers `401`. Replaces `requireApiKey`. |
| `src/routes/auth.ts` | Auth routes. |
| `src/validation/authSchema.ts` | zod schemas for sign-up and login. |

### Auth routes (`/api/auth`)

| Route | Behaviour |
|---|---|
| `POST /signup` | Body: `email`, `password`, `remember` (optional boolean). `403` if `ALLOW_SIGNUP=false` and a user exists. `409` if the email exists. Creates the user, seeds default categories, signs in. `201` with `{ id, email }`. |
| `POST /login` | Same body. A wrong email and a wrong password give the same `401` message. Sets the cookie. `200` with `{ id, email }`. |
| `POST /logout` | Deletes the session row and clears the cookie. `200`. |
| `GET /me` | `200` with `{ id, email }`, or `401`. |

Rules:

- Email is trimmed and stored in lower case. Password: 8 to 200 characters.
- Failed logins: after 5 failures for the same email and address, further attempts get `429` for 15 minutes. The counter lives in memory and resets when the server restarts. A successful login clears it.
- Cookie `sid`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV=production`. `Max-Age` is set only when remember me is checked.
- Cross-site requests: `SameSite=Lax` stops other sites from sending the cookie on a POST, and the API accepts only JSON bodies.

### Changes to existing code

- Every `DEMO_USER_ID` use becomes `req.userId`: `src/routes/expenses.ts`, `src/routes/rules.ts`, `src/routes/push.ts`.
- `requireApiKey` is replaced by `requireUser` on every dashboard route. The list, categories and rules routes also need sign-in now, because they are public today.
- `src/routes/categories.ts`: every query adds `user_id = req.userId`. A rename rewrites `expenses.category` and `merchant_rules.category` only for that user.
- `registerCategory(client, userId, name)` takes the user id and conflicts on `(user_id, lower(trim(name)))`. `createManualExpense` and `recategorizeExpense` already know the user. `finalizeCategory` reads the user id from the pending expense row first.
- `GET /api/expenses/:id` and `PATCH /:id/category` already filter by user. `POST /:id/categorize` does not, so add a user check to it. A foreign id gets `404` on all three. `POST /:id/categorize-from-notification` keeps its per-expense token and has no user check.
- Bank webhook route: before inserting, check that the payload `user_id` exists in `users`. If not, `404` and nothing is stored.
- Unchanged: the webhook HMAC signature, the per-expense token for phone alert buttons, the sweep job (already per user), `scripts/mockBank.ts` (already sends `usr_demo_1`).
- Remove `requireApiKey.ts`, the `DASHBOARD_API_KEY` line from `.env.example`, and `DEMO_USER_ID` from `src/constants.ts` once nothing uses them. Add `ALLOW_SIGNUP` to `.env.example`.

## Frontend

- New `public/login.html` and `public/auth.js`: email, password, "Remember me" checkbox, and a switch between "Sign in" and "Create account". Errors show on the page. On success, go to `/`.
- `public/app.js`: on load, call `GET /api/auth/me`. On `401`, go to `login.html`. Any later `401` from the API does the same. Remove `getApiKey()`, the `window.prompt`, and `apiKeyFetch()`; use plain `fetch`, which sends the cookie.
- `public/index.html`: the header shows the signed-in email and a "Sign out" button.
- `public/sw.js` is unchanged.

## Testing

All testing uses a separate database, `expense_tracker_test`, in the same Postgres container, with a second server on port 3002. The first account takes over `usr_demo_1`, so the first sign-up must never be a test account on the real database. You create your own first account on the real database.

Unit tests (`npm test`, `node:test`):

- Password: the right password verifies, a wrong one does not, the format is `scrypt$salt$hash`, and hashing the same password twice gives two different strings.
- Session token: the stored hash is `sha256` of the token, and the token is never stored.
- Cookie parsing and `Set-Cookie` building, with and without remember me.
- Rate limiter: the 6th failure inside 15 minutes is blocked, a success clears the counter.
- Auth schemas: bad email, password shorter than 8 or longer than 200.

API checks with `curl` against the test database:

- The first sign-up gets the id `usr_demo_1`, the second gets a random id.
- A new account has exactly Food, Transport and Other, and no expenses.
- A user cannot read, categorize or recategorize another user's expense (`404`).
- A user's category rename does not touch another user's expenses.
- Unauthenticated calls to the list, categories, rules and push routes return `401`.
- A wrong password and an unknown email return the same message.
- Remember me checked sets `Max-Age`. Unchecked sets none.
- After logout the old cookie returns `401`.
- The 6th failed login returns `429`.
- With `ALLOW_SIGNUP=false`, sign-up returns `403` once a user exists.
- A signed webhook for an unknown `user_id` returns `404` and stores nothing. A signed webhook for `usr_demo_1` works.

Migration check on a copy of the real data: the existing 51 expenses, rules and subscriptions still belong to `usr_demo_1`, and the category counts are unchanged.

Browser check: sign up, sign out, sign in, remember me, a second account in a private window sees empty data, and the dashboard redirects to the login page when signed out.

## Out of scope

Password reset by email, email verification, change password, delete account, sign-in with Google, two-factor sign-in, an admin screen, and separate phone-alert handling when two users share one browser (the subscription belongs to whoever subscribed last on that device). Each can be a later step. Before the app is put behind a proxy, set Express "trust proxy" so the login limit sees real client addresses, and consider limiting by address range as well as by email plus address.
