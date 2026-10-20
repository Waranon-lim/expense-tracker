# Login and Multiple Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People sign in with email and password. Each user sees only their own expenses, categories, learned rules and phone alerts. The fixed demo user and the shared API key are removed.

**Architecture:** Server-side sessions. A random token lives in an `HttpOnly` cookie, and the database stores only its SHA-256 hash. A `requireUser` middleware replaces `requireApiKey` and sets `req.userId`. The first account gets the id `usr_demo_1`, so existing data needs no move. Categories gain a `user_id` column. Pure logic (password hashing, cookies, rate limit, schemas) has unit tests. Database behaviour is checked by a smoke script against a separate test database.

**Tech Stack:** Node.js, TypeScript, Express 4, PostgreSQL (Docker, port 5433), zod, Node `crypto.scrypt`, vanilla JS frontend, `node:test` through `tsx`. No new packages.

**Spec:** `docs/moai/specs/2026-10-20-login-multi-user-design.md`

## Read this first

- **Never create a test account on the real database.** The first sign-up takes over `usr_demo_1` and all your data. All testing in this plan uses the database `expense_tracker_test` and a second server on port 3002. The real account is created by the user in Task 10. An agent must never type a password for the user.
- **Real database:** 51 or more expenses of the user live in `expense_tracker`. Do not run migration 008 on it until Task 10. The user's server on port 3001 breaks the moment the migration runs (old code does not know the new category index), so migration and restart happen together in Task 10.
- **Never run `npm run migrate`.** It re-runs every migration file. Apply migrations with `psql`.
- **Docker** must be running. Check with `docker compose ps` (service name `postgres`, user, password and database `expense_tracker`).
- **Test server command** (used in several tasks, run it in the background):

```bash
DATABASE_URL=postgresql://expense_tracker:expense_tracker@localhost:5433/expense_tracker_test PORT=3002 NOTIFICATION_SECRET=test-secret ALLOW_SIGNUP=true npx tsx src/server.ts
```

  Check it with `curl -s http://localhost:3002/health` (expect `{"ok":true}`). Stop only the process you started (`lsof -tiTCP:3002 -sTCP:LISTEN`). Never touch the process on port 3001.
- **Two small changes to the spec** (the plan makes them, Task 7 writes them into the spec): phone-alert tokens used `DASHBOARD_API_KEY` as their secret, so a new `NOTIFICATION_SECRET` setting replaces it. Pure session-token helpers live in `src/services/sessionToken.ts` so they can be unit tested without a database.
- The branch for this work is `feat/login-multi-user`.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `migrations/008_users_sessions_per_user_categories.sql` | create | `users`, `sessions`, per-user `categories` |
| `scripts/fixtures/reset_test_db.sql` | create | Empty the test database (refuses any other database) |
| `scripts/fixtures/legacy_demo_data.sql` | create | One legacy `usr_demo_1` expense and rule, for the claim test |
| `src/services/passwordHash.ts` | create | `hashPassword`, `verifyPassword`, `burnPasswordCheck` |
| `src/services/sessionToken.ts` | create | `newSessionToken`, `hashSessionToken` (pure) |
| `src/utils/cookies.ts` | create | Parse `Cookie`, build `Set-Cookie` |
| `src/utils/loginRateLimit.ts` | create | In-memory failed login limiter |
| `src/validation/authSchema.ts` | create | zod schemas for sign-up and login |
| `src/services/users.ts` | create | Create user, find user, seed default categories |
| `src/services/sessions.ts` | create | Create, find, delete sessions |
| `src/middleware/requireUser.ts` | create | Cookie to `req.userId`, or `401` |
| `src/routes/auth.ts` | create | `/api/auth/*` |
| `src/server.ts` | modify | Mount the auth router |
| `src/services/categorizationFinalizer.ts` | modify | Per-user `registerCategory`, owner check in `finalizeCategory` |
| `src/services/createManualExpense.ts` | modify | Pass the user to `registerCategory` |
| `src/routes/categories.ts` | rewrite | Every query scoped to the user |
| `src/routes/expenses.ts` | modify | `requireUser` and `req.userId` |
| `src/routes/rules.ts` | rewrite | Same |
| `src/routes/push.ts` | rewrite | Same |
| `src/routes/webhook.ts` | modify | Unknown user gets `404` |
| `src/services/pushNotifications.ts` | modify | Token secret from `NOTIFICATION_SECRET` |
| `src/constants.ts` | modify | Remove `DEMO_USER_ID` |
| `src/middleware/requireApiKey.ts` | delete | Replaced |
| `.env.example`, `README.md` | modify | New settings and sign-in docs |
| `public/login.html`, `public/auth.js` | create | Sign-in and sign-up page |
| `public/index.html`, `public/app.js`, `public/style.css` | modify | `authFetch`, user email, sign out, login styles |
| `scripts/authSmoke.ts` | create | End-to-end checks against the test server |
| `tests/passwordHash.test.ts`, `tests/sessionToken.test.ts`, `tests/cookies.test.ts`, `tests/loginRateLimit.test.ts`, `tests/authSchema.test.ts` | create | Unit tests |

---

### Task 1: Branch, test database and migration 008

**Files:**
- Create: `migrations/008_users_sessions_per_user_categories.sql`
- Create: `scripts/fixtures/reset_test_db.sql`
- Create: `scripts/fixtures/legacy_demo_data.sql`

- [ ] **Step 1: Create the branch**

Run: `git checkout -b feat/login-multi-user && git status --short`
Expected: `Switched to a new branch 'feat/login-multi-user'`, and only `?? .DS_Store` listed.

- [ ] **Step 2: Write the migration**

Create `migrations/008_users_sessions_per_user_categories.sql`:

```sql
-- Accounts, sessions, and per-user categories.
-- The whole file is one transaction: if any line fails, nothing changes.
BEGIN;

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- Only the SHA-256 hash of the session token is stored, so a leaked database
-- does not give out working sessions.
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Categories were shared by everyone. Every existing row belongs to the demo
-- user, who becomes the first account (id usr_demo_1).
ALTER TABLE categories ADD COLUMN user_id TEXT;
UPDATE categories SET user_id = 'usr_demo_1';
ALTER TABLE categories ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE categories DROP CONSTRAINT categories_name_key;
DROP INDEX categories_name_lower_idx;
CREATE UNIQUE INDEX categories_user_name_lower_idx ON categories (user_id, lower(trim(name)));

COMMIT;
```

- [ ] **Step 3: Write the two test-database fixture files**

Create `scripts/fixtures/reset_test_db.sql`:

```sql
-- Empties the TEST database. Refuses to run on any other database.
-- Run with: psql -v ON_ERROR_STOP=1 -d expense_tracker_test -f this file
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'expense_tracker_test' THEN
    RAISE EXCEPTION 'Refusing to reset database %', current_database();
  END IF;
END $$;

TRUNCATE users, sessions, expenses, processed_webhooks, merchant_rules, push_subscriptions RESTART IDENTITY CASCADE;
DELETE FROM categories;
INSERT INTO categories (user_id, name, color, is_default) VALUES
  ('usr_demo_1', 'Food', '#16a34a', true),
  ('usr_demo_1', 'Transport', '#2563eb', true),
  ('usr_demo_1', 'Other', '#64748b', true);

COMMIT;
```

Create `scripts/fixtures/legacy_demo_data.sql`:

```sql
-- One expense and one learned rule that belong to the old demo user, so the
-- smoke test can check that the first account takes them over.
WITH w AS (
  INSERT INTO processed_webhooks (provider, provider_transaction_id, status, payload)
  VALUES ('mock_bank', 'legacy_test_1', 'completed', '{}')
  RETURNING id
)
INSERT INTO expenses (
  user_id, amount, currency, merchant, category, raw_bank_category, status,
  category_source, source, webhook_id, transaction_date, received_at, categorized_at
)
SELECT 'usr_demo_1', 99, 'THB', 'LEGACY TEST Coffee', 'Food', 'COFFEE', 'categorized',
       'mapping', 'bank_webhook', w.id, now(), now(), now()
FROM w;

INSERT INTO merchant_rules (user_id, merchant_key, category)
VALUES ('usr_demo_1', 'legacy test coffee', 'Food');
```

- [ ] **Step 4: Rehearse the migration on a copy of the real data**

This does not touch the real database. Run:

```bash
docker compose exec -T postgres psql -U expense_tracker -d postgres -c "CREATE DATABASE expense_tracker_copy;"
docker compose exec -T postgres pg_dump -U expense_tracker expense_tracker | docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_copy -q
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_copy -t -c "SELECT (SELECT count(*) FROM expenses), (SELECT count(*) FROM categories), (SELECT count(*) FROM merchant_rules), (SELECT count(*) FROM push_subscriptions);"
```

Write down the four counts (BEFORE). Then apply and compare:

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_copy -v ON_ERROR_STOP=1 -q < migrations/008_users_sessions_per_user_categories.sql
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_copy -t -c "SELECT (SELECT count(*) FROM expenses), (SELECT count(*) FROM categories), (SELECT count(*) FROM merchant_rules), (SELECT count(*) FROM push_subscriptions), (SELECT count(*) FROM categories WHERE user_id = 'usr_demo_1'), (SELECT count(*) FROM users);"
```

Expected: the first four numbers are equal to BEFORE, the fifth equals the categories count, and the last (users) is `0`.

Now prove the reset script refuses any database that is not the test database. Run it against the copy, which is disposable:

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_copy -v ON_ERROR_STOP=1 -q < scripts/fixtures/reset_test_db.sql
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_copy -t -c "SELECT count(*) FROM expenses;"
```

Expected: the first command fails with `Refusing to reset database expense_tracker_copy`, and the second still shows the same expenses count as BEFORE (nothing was deleted). **Never run the reset script against `expense_tracker`, the real database.**

- [ ] **Step 5: Delete the copy**

Run: `docker compose exec -T postgres psql -U expense_tracker -d postgres -c "DROP DATABASE expense_tracker_copy;"`
Expected: `DROP DATABASE`.

- [ ] **Step 6: Create the test database and apply every migration to it**

```bash
docker compose exec -T postgres psql -U expense_tracker -d postgres -c "CREATE DATABASE expense_tracker_test;"
for f in migrations/00*.sql; do echo "applying $f"; docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_test -v ON_ERROR_STOP=1 -q < "$f" || break; done
```

Expected: eight `applying ...` lines (001 to 008) and no `ERROR`.

- [ ] **Step 7: Check the reset and fixture files work on the test database**

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_test -v ON_ERROR_STOP=1 -q < scripts/fixtures/reset_test_db.sql
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_test -v ON_ERROR_STOP=1 -q < scripts/fixtures/legacy_demo_data.sql
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_test -t -c "SELECT (SELECT count(*) FROM expenses), (SELECT count(*) FROM categories), (SELECT count(*) FROM merchant_rules);"
```

Expected: the count line shows `1 | 3 | 1`. Then confirm the real data is intact: `docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -t -c "SELECT count(*) FROM expenses;"` shows the same number of expenses as before this task (50 or more, not 0).

- [ ] **Step 8: Commit**

```bash
git add migrations/008_users_sessions_per_user_categories.sql scripts/fixtures/reset_test_db.sql scripts/fixtures/legacy_demo_data.sql
git commit -m "feat: add users, sessions and per-user categories migration

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Password hashing and session token helpers (unit tested)

**Files:**
- Create: `tests/passwordHash.test.ts`
- Create: `tests/sessionToken.test.ts`
- Create: `src/services/passwordHash.ts`
- Create: `src/services/sessionToken.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/passwordHash.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '../src/services/passwordHash';

describe('passwordHash', () => {
  it('stores the hash as scrypt$salt$hash', async () => {
    const stored = await hashPassword('correct horse battery');
    const parts = stored.split('$');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'scrypt');
    assert.match(parts[1], /^[0-9a-f]{32}$/); // 16 random bytes
    assert.match(parts[2], /^[0-9a-f]{128}$/); // 64 byte hash
  });

  it('accepts the right password', async () => {
    const stored = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse battery', stored), true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse batterz', stored), false);
  });

  it('gives a different hash each time for the same password', async () => {
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');
    assert.notEqual(first, second);
    assert.equal(await verifyPassword('same password', first), true);
    assert.equal(await verifyPassword('same password', second), true);
  });

  it('returns false, not an error, for a malformed stored hash', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
    assert.equal(await verifyPassword('anything', 'scrypt$zz$zz'), false);
  });
});
```

Create `tests/sessionToken.test.ts`:

```ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { hashSessionToken, newSessionToken } from '../src/services/sessionToken';

describe('sessionToken', () => {
  it('makes a 43 character URL-safe token (32 random bytes)', () => {
    assert.match(newSessionToken(), /^[A-Za-z0-9_-]{43}$/);
  });

  it('makes a different token each time', () => {
    assert.notEqual(newSessionToken(), newSessionToken());
  });

  it('stores the SHA-256 hex of the token, never the token', () => {
    const token = newSessionToken();
    const stored = hashSessionToken(token);
    assert.equal(stored, crypto.createHash('sha256').update(token).digest('hex'));
    assert.notEqual(stored, token);
    assert.equal(hashSessionToken(token), stored); // same input, same output
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. The error says it cannot find module `../src/services/passwordHash` (or `sessionToken`).

- [ ] **Step 3: Write the implementations**

Create `src/services/passwordHash.ts`:

```ts
import crypto from 'node:crypto';
import { promisify } from 'node:util';

// scrypt is a password hash that is slow on purpose and needs a lot of memory,
// so guessing passwords from a leaked hash is expensive. It ships with Node.
const scrypt = promisify(crypto.scrypt) as unknown as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

// The salt is random for every hash, so two users with the same password get
// different stored strings. The salt is kept inside the string, because the
// check needs it again.
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length !== SALT_BYTES || expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, salt, KEY_LENGTH);
  // timingSafeEqual takes the same time however many bytes match.
  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;

// Login for an email that does not exist still spends the same time hashing,
// so the response time does not reveal which emails have accounts.
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummyHash);
}
```

Create `src/services/sessionToken.ts`:

```ts
import crypto from 'node:crypto';

// The browser holds the token. The database holds only its hash, so a leaked
// database does not give out working sessions. SHA-256 is enough here (not
// scrypt) because the token is 32 random bytes, not a guessable password.
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npx tsc --noEmit`
Expected: the summary shows `# tests 26`, `# pass 26`, `# fail 0` (18 existing plus 8 new), and no type errors.

- [ ] **Step 5: Commit**

```bash
git add tests/passwordHash.test.ts tests/sessionToken.test.ts src/services/passwordHash.ts src/services/sessionToken.ts
git commit -m "feat: add password hashing and session token helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Cookies, login rate limiter and auth schemas (unit tested)

**Files:**
- Create: `tests/cookies.test.ts`
- Create: `tests/loginRateLimit.test.ts`
- Create: `tests/authSchema.test.ts`
- Create: `src/utils/cookies.ts`
- Create: `src/utils/loginRateLimit.ts`
- Create: `src/validation/authSchema.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/cookies.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildClearCookie, buildSessionCookie, parseCookies } from '../src/utils/cookies';

describe('parseCookies', () => {
  it('reads several cookies from one header', () => {
    assert.deepEqual(parseCookies('a=1; sid=abc; b=2'), { a: '1', sid: 'abc', b: '2' });
  });

  it('returns an empty object when there is no header', () => {
    assert.deepEqual(parseCookies(undefined), {});
  });
});

describe('buildSessionCookie', () => {
  it('sets HttpOnly, SameSite=Lax, Path and Max-Age when remember me is on', () => {
    const cookie = buildSessionCookie('tok', { maxAgeSeconds: 2592000, secure: false });
    assert.equal(cookie, 'sid=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
  });

  it('has no Max-Age without remember me, so it ends with the browser session', () => {
    const cookie = buildSessionCookie('tok', { secure: false });
    assert.equal(cookie, 'sid=tok; Path=/; HttpOnly; SameSite=Lax');
  });

  it('adds Secure in production', () => {
    assert.match(buildSessionCookie('tok', { secure: true }), /; Secure$/);
  });
});

describe('buildClearCookie', () => {
  it('empties the cookie and expires it at once', () => {
    assert.equal(buildClearCookie(false), 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  });
});
```

Create `tests/loginRateLimit.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoginRateLimiter } from '../src/utils/loginRateLimit';

const WINDOW = 15 * 60 * 1000;

describe('loginRateLimiter', () => {
  it('does not block before 5 failures', () => {
    const limiter = createLoginRateLimiter({ now: () => 0 });
    for (let i = 0; i < 4; i++) limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('a'), false);
  });

  it('blocks after 5 failures', () => {
    const limiter = createLoginRateLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i++) limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('a'), true);
  });

  it('unblocks after 15 minutes', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({ now: () => time });
    for (let i = 0; i < 5; i++) limiter.recordFailure('a');
    time = WINDOW - 1;
    assert.equal(limiter.isBlocked('a'), true);
    time = WINDOW + 1;
    assert.equal(limiter.isBlocked('a'), false);
  });

  it('clears the count after a successful login', () => {
    const limiter = createLoginRateLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i++) limiter.recordFailure('a');
    limiter.clear('a');
    assert.equal(limiter.isBlocked('a'), false);
  });

  it('counts each key on its own', () => {
    const limiter = createLoginRateLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i++) limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('b'), false);
  });
});
```

Create `tests/authSchema.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LoginSchema, SignupSchema } from '../src/validation/authSchema';

describe('SignupSchema', () => {
  it('trims and lower-cases the email, and defaults remember to false', () => {
    const parsed = SignupSchema.parse({ email: '  Me@Example.COM ', password: 'longenough' });
    assert.deepEqual(parsed, { email: 'me@example.com', password: 'longenough', remember: false });
  });

  it('accepts remember true', () => {
    assert.equal(SignupSchema.parse({ email: 'a@b.co', password: 'longenough', remember: true }).remember, true);
  });

  it('rejects an invalid email', () => {
    assert.equal(SignupSchema.safeParse({ email: 'not-an-email', password: 'longenough' }).success, false);
  });

  it('rejects a password shorter than 8 characters', () => {
    assert.equal(SignupSchema.safeParse({ email: 'a@b.co', password: '1234567' }).success, false);
  });

  it('rejects a password longer than 200 characters', () => {
    assert.equal(SignupSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(201) }).success, false);
  });
});

describe('LoginSchema', () => {
  it('has the same shape as sign-up', () => {
    const parsed = LoginSchema.parse({ email: 'A@B.co', password: 'longenough', remember: true });
    assert.deepEqual(parsed, { email: 'a@b.co', password: 'longenough', remember: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module` for `../src/utils/cookies` (or the other new modules).

- [ ] **Step 3: Write the implementations**

Create `src/utils/cookies.ts`:

```ts
export const SESSION_COOKIE = 'sid';

// Reads the request's Cookie header ("a=1; sid=abc") into an object. Written
// by hand so the project needs no extra package for one small job.
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

// HttpOnly: page JavaScript cannot read the cookie.
// SameSite=Lax: other sites cannot send it along with a POST.
// Max-Age is set only for "remember me". Without it the cookie ends when the
// browser closes.
export function buildSessionCookie(token: string, options: { maxAgeSeconds?: number; secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
```

Create `src/utils/loginRateLimit.ts`:

```ts
interface Entry {
  count: number;
  firstAt: number;
}

export interface LoginRateLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

// Counts failed logins per key (email plus address) inside a fixed window that
// starts at the first failure. It lives in memory, so it resets when the
// server restarts. That is enough to stop quick password guessing.
export function createLoginRateLimiter({
  maxFailures = 5,
  windowMs = 15 * 60 * 1000,
  now = Date.now,
}: LoginRateLimiterOptions = {}) {
  const entries = new Map<string, Entry>();

  function current(key: string): Entry | undefined {
    const entry = entries.get(key);
    if (entry && now() - entry.firstAt > windowMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    isBlocked(key: string): boolean {
      const entry = current(key);
      return entry !== undefined && entry.count >= maxFailures;
    },
    recordFailure(key: string): void {
      const entry = current(key);
      if (entry) entry.count += 1;
      else entries.set(key, { count: 1, firstAt: now() });
    },
    clear(key: string): void {
      entries.delete(key);
    },
  };
}

export const loginRateLimiter = createLoginRateLimiter();
```

Create `src/validation/authSchema.ts`:

```ts
import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(200);

export const SignupSchema = z.object({
  email,
  password,
  remember: z.boolean().optional().default(false),
});

export const LoginSchema = z.object({
  email,
  password,
  remember: z.boolean().optional().default(false),
});

export type SignupRequest = z.infer<typeof SignupSchema>;
export type LoginRequest = z.infer<typeof LoginSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npx tsc --noEmit`
Expected: the summary shows `# tests 43`, `# pass 43`, `# fail 0` (26 plus 17 new), and no type errors.

- [ ] **Step 5: Commit**

```bash
git add tests/cookies.test.ts tests/loginRateLimit.test.ts tests/authSchema.test.ts src/utils/cookies.ts src/utils/loginRateLimit.ts src/validation/authSchema.ts
git commit -m "feat: add cookie helpers, login rate limiter and auth schemas

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: User and session services, and the `requireUser` middleware

**Files:**
- Create: `src/services/users.ts`
- Create: `src/services/sessions.ts`
- Create: `src/middleware/requireUser.ts`

These touch the database. They are checked by the smoke script (Task 9), and here by the type check.

- [ ] **Step 1: Write `src/services/users.ts`**

```ts
import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

// The first account takes this id, so every row the old single-user app wrote
// (expenses, learned rules, phone alert subscriptions, categories) already
// belongs to it and nothing has to move.
export const FIRST_USER_ID = 'usr_demo_1';

const DEFAULT_CATEGORIES = [
  { name: 'Food', color: '#16a34a' },
  { name: 'Transport', color: '#2563eb' },
  { name: 'Other', color: '#64748b' },
] as const;

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

export async function countUsers(db: Pool): Promise<number> {
  const result = await db.query('SELECT count(*)::int AS count FROM users');
  return result.rows[0].count as number;
}

export async function findUserByEmail(db: Pool, email: string): Promise<UserRow | null> {
  const result = await db.query('SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)', [email]);
  return (result.rows[0] as UserRow | undefined) ?? null;
}

export async function userExists(db: Pool, id: string): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM users WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

async function seedDefaultCategories(client: PoolClient, userId: string): Promise<void> {
  for (const { name, color } of DEFAULT_CATEGORIES) {
    await client.query(
      `INSERT INTO categories (user_id, name, color, is_default)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (user_id, lower(trim(name))) DO NOTHING`,
      [userId, name, color],
    );
  }
}

// Returns null when the email is already taken. The advisory lock makes two
// sign-ups at the same moment take turns, so only one can become the first user.
export async function createUser(
  pool: Pool,
  email: string,
  passwordHash: string,
): Promise<{ id: string; email: string } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(8008)');
    const existing = await client.query('SELECT count(*)::int AS count FROM users');
    const id = existing.rows[0].count === 0 ? FIRST_USER_ID : `usr_${crypto.randomBytes(4).toString('hex')}`;
    await client.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [id, email, passwordHash]);
    await seedDefaultCategories(client, id);
    await client.query('COMMIT');
    return { id, email };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 23505 = unique violation. Only the email index means "email taken".
    if ((err as { code?: string; constraint?: string }).code === '23505' &&
        (err as { constraint?: string }).constraint === 'users_email_lower_idx') {
      return null;
    }
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Write `src/services/sessions.ts`**

```ts
import type { Pool } from 'pg';
import { hashSessionToken, newSessionToken } from './sessionToken';

export const REMEMBER_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SHORT_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface NewSession {
  token: string;
  /** Set only for "remember me". Without it the cookie ends with the browser session. */
  maxAgeSeconds?: number;
}

export async function createSession(db: Pool, userId: string, remember: boolean): Promise<NewSession> {
  // Old sessions are removed here, at each login, so no separate cleanup job is needed.
  await db.query('DELETE FROM sessions WHERE expires_at < now()');

  const token = newSessionToken();
  const lifetimeMs = remember ? REMEMBER_LIFETIME_MS : SHORT_LIFETIME_MS;
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3::double precision))`,
    [hashSessionToken(token), userId, lifetimeMs / 1000],
  );
  return { token, maxAgeSeconds: remember ? REMEMBER_LIFETIME_MS / 1000 : undefined };
}

export async function findSessionUser(db: Pool, token: string): Promise<{ id: string; email: string } | null> {
  const result = await db.query(
    `SELECT u.id, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashSessionToken(token)],
  );
  return (result.rows[0] as { id: string; email: string } | undefined) ?? null;
}

export async function deleteSession(db: Pool, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
}
```

- [ ] **Step 3: Write `src/middleware/requireUser.ts`**

```ts
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/pool';
import { findSessionUser } from '../services/sessions';
import { SESSION_COOKIE, parseCookies } from '../utils/cookies';

// Adds the signed-in user to the request type. Every route that uses
// requireUser can rely on these being set.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
      userEmail: string;
    }
  }
}

// Replaces requireApiKey. Reads the session cookie, finds a live session, and
// puts the user on the request. No cookie or no live session gives 401.
export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = token ? await findSessionUser(pool, token) : null;
    if (!user) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    req.userId = user.id;
    req.userEmail = user.email;
    next();
  } catch (err) {
    next(err);
  }
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (no errors).

- [ ] **Step 5: Commit**

```bash
git add src/services/users.ts src/services/sessions.ts src/middleware/requireUser.ts
git commit -m "feat: add user and session services and requireUser middleware

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Auth routes

**Files:**
- Create: `src/routes/auth.ts`
- Modify: `src/server.ts` (import near line 11, mount near line 38)

- [ ] **Step 1: Write `src/routes/auth.ts`**

```ts
import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { requireUser } from '../middleware/requireUser';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../services/passwordHash';
import { createSession, deleteSession } from '../services/sessions';
import { countUsers, createUser, findUserByEmail } from '../services/users';
import { SESSION_COOKIE, buildClearCookie, buildSessionCookie, parseCookies } from '../utils/cookies';
import { loginRateLimiter } from '../utils/loginRateLimit';
import { LoginSchema, SignupSchema } from '../validation/authSchema';

export const authRouter = Router();

const secureCookies = () => process.env.NODE_ENV === 'production';

// A wrong email and a wrong password give the same message, so the answer does
// not reveal which emails have accounts.
const WRONG_LOGIN = 'Wrong email or password';

authRouter.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    const { email, password, remember } = parsed.data;

    // ALLOW_SIGNUP=false closes sign-up, but the very first account must always
    // be possible, otherwise nobody could ever sign in.
    if (process.env.ALLOW_SIGNUP === 'false' && (await countUsers(pool)) > 0) {
      res.status(403).json({ error: 'Sign-up is closed' });
      return;
    }

    const user = await createUser(pool, email, await hashPassword(password));
    if (!user) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const session = await createSession(pool, user.id, remember);
    res.setHeader('Set-Cookie', buildSessionCookie(session.token, { maxAgeSeconds: session.maxAgeSeconds, secure: secureCookies() }));
    res.status(201).json({ id: user.id, email: user.email });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    const { email, password, remember } = parsed.data;

    const limitKey = `${email}|${req.ip}`;
    if (loginRateLimiter.isBlocked(limitKey)) {
      res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      return;
    }

    const user = await findUserByEmail(pool, email);
    let passwordOk = false;
    if (user) {
      passwordOk = await verifyPassword(password, user.password_hash);
    } else {
      await burnPasswordCheck(password);
    }

    if (!user || !passwordOk) {
      loginRateLimiter.recordFailure(limitKey);
      res.status(401).json({ error: WRONG_LOGIN });
      return;
    }

    loginRateLimiter.clear(limitKey);
    const session = await createSession(pool, user.id, remember);
    res.setHeader('Set-Cookie', buildSessionCookie(session.token, { maxAgeSeconds: session.maxAgeSeconds, secure: secureCookies() }));
    res.status(200).json({ id: user.id, email: user.email });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await deleteSession(pool, token);
    res.setHeader('Set-Cookie', buildClearCookie(secureCookies()));
    res.status(200).json({ signedOut: true });
  }),
);

authRouter.get('/me', requireUser, (req, res) => {
  res.status(200).json({ id: req.userId, email: req.userEmail });
});
```

- [ ] **Step 2: Mount the router in `src/server.ts`**

After the line `import { rulesRouter } from './routes/rules';` add:

```ts
import { authRouter } from './routes/auth';
```

And directly before the line `app.use('/api/expenses', expensesRouter);` add:

```ts
app.use('/api/auth', authRouter);
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 4: Start the test server and reset the test database**

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_test -v ON_ERROR_STOP=1 -q < scripts/fixtures/reset_test_db.sql
```

Then start the test server (see "Read this first") in the background and wait until `curl -s http://localhost:3002/health` returns `{"ok":true}`.

- [ ] **Step 5: Check sign-up, cookie, me, logout and login by hand**

Run (the cookie jar file goes in the current folder and is deleted at the end of this step):

```bash
curl -s -i -c jar.txt -X POST http://localhost:3002/api/auth/signup -H 'Content-Type: application/json' -d '{"email":"Plan.Test@Example.com","password":"correct horse battery","remember":true}'
curl -s -b jar.txt http://localhost:3002/api/auth/me
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3002/api/auth/me
curl -s -i -b jar.txt -X POST http://localhost:3002/api/auth/logout
curl -s -o /dev/null -w 'me after logout -> %{http_code}\n' -b jar.txt http://localhost:3002/api/auth/me
curl -s -X POST http://localhost:3002/api/auth/login -H 'Content-Type: application/json' -d '{"email":"plan.test@example.com","password":"wrong password here"}'
rm -f jar.txt
```

Expected, in order:
1. `HTTP/1.1 201 Created`, header `Set-Cookie: sid=...; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, body `{"id":"usr_demo_1","email":"plan.test@example.com"}`.
2. `{"id":"usr_demo_1","email":"plan.test@example.com"}`.
3. `401` (no cookie sent).
4. `HTTP/1.1 200 OK` with `Set-Cookie: sid=; ... Max-Age=0`.
5. `me after logout -> 401`.
6. `{"error":"Wrong email or password"}`.

- [ ] **Step 6: Stop the test server and reset the test database**

Stop only the process on port 3002. Then run the reset command from Step 4 again, so the next task starts with no users.

- [ ] **Step 7: Commit**

```bash
git add src/routes/auth.ts src/server.ts
git commit -m "feat: add sign-up, login, logout and me routes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Per-user categories

**Files:**
- Modify (full replacement): `src/services/categorizationFinalizer.ts`
- Modify: `src/services/createManualExpense.ts`
- Modify (full replacement): `src/routes/categories.ts`

The routes still use `requireApiKey` after this task for `expenses.ts`, `rules.ts` and `push.ts`. `categories.ts` moves to `requireUser` now because it needs `req.userId`.

- [ ] **Step 1: Replace `src/services/categorizationFinalizer.ts`**

```ts
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


// Registers the category for this user (or reuses one that only differs in
// case/whitespace, e.g. "food" vs "Food") so it shows up as a quick-pick option
// and in the filter dropdown. The categories_user_name_lower_idx unique index
// makes this atomic under concurrent first-time inserts of the same name.
export async function registerCategory(client: PoolClient, userId: string, rawCategory: string): Promise<string> {
  const trimmedCategory = rawCategory.trim();
  const result = await client.query(
    `INSERT INTO categories (user_id, name, color)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, lower(trim(name))) DO UPDATE SET name = categories.name
     RETURNING name`,
    [userId, trimmedCategory, colorForCategoryName(trimmedCategory)],
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
    const category = await registerCategory(client, userId, rawCategory);
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
 *
 * The category is registered for the expense's own user, which is read from the
 * pending row (and locked with FOR UPDATE, so a tap and the sweep take turns).
 * `ownerUserId` is passed by routes that act for a signed-in user: an expense of
 * another user then counts as "not found". The sweep and the phone-alert route
 * leave it out.
 */
export async function finalizeCategory(
  pool: Pool,
  expenseId: number,
  rawCategory: string,
  source: Exclude<CategorySource, null>,
  ownerUserId?: string,
): Promise<FinalizeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pending = await client.query(
      `SELECT user_id FROM expenses
       WHERE id = $1 AND status = 'pending' AND ($2::text IS NULL OR user_id = $2)
       FOR UPDATE`,
      [expenseId, ownerUserId ?? null],
    );
    if (pending.rowCount === 0) {
      await client.query('ROLLBACK');
      return { applied: false, expenseId };
    }
    const userId = pending.rows[0].user_id as string;

    const category = await registerCategory(client, userId, rawCategory);

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
```

- [ ] **Step 2: Pass the user in `createManualExpense`**

In `src/services/createManualExpense.ts`, change:

```ts
    const category = await registerCategory(client, params.category);
```

to:

```ts
    const category = await registerCategory(client, params.userId, params.category);
```

- [ ] **Step 3: Replace `src/routes/categories.ts`**

```ts
import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { z } from 'zod';
import { requireUser } from '../middleware/requireUser';

export const categoriesRouter = Router();

// Every query below is limited to the signed-in user's own categories.
categoriesRouter.get(
  '/',
  requireUser,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, color, is_default FROM categories WHERE user_id = $1 ORDER BY is_default DESC, name ASC`,
      [req.userId],
    );
    res.status(200).json(result.rows);
  }),
);

// Removes a category from the picker/filter options. Doesn't touch any
// expenses already using it — their `category` text column is untouched,
// this only stops it being offered for *future* categorization.
categoriesRouter.delete(
  '/:id',
  requireUser,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid category id' });
      return;
    }

    const existing = await pool.query('SELECT is_default FROM categories WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (existing.rowCount === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    if (existing.rows[0].is_default) {
      res.status(403).json({ error: 'Cannot delete a default category' });
      return;
    }

    await pool.query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [id, req.userId]);
    res.status(200).json({ deleted: true });
  }),
);

const UpdateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must look like #1a2b3c').optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, { message: 'Nothing to change' });

// Edits a category's name and/or color. Default categories keep their name
// (the built-in merchant guesses refer to "Food"/"Transport"/"Other" by name)
// but can be recolored. A rename also rewrites the old name on this user's
// existing expenses and learned rules, otherwise they would point at a category
// that no longer exists. Other users' data is never touched.
categoriesRouter.patch(
  '/:id',
  requireUser,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid category id' });
      return;
    }
    const parsed = UpdateCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT name, is_default FROM categories WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, req.userId],
      );
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Category not found' });
        return;
      }
      const oldName = existing.rows[0].name as string;
      const newName = parsed.data.name ?? oldName;
      const renaming = newName !== oldName;

      if (renaming && existing.rows[0].is_default) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'Default categories can be recolored but not renamed' });
        return;
      }

      try {
        await client.query('UPDATE categories SET name = $1, color = COALESCE($2, color) WHERE id = $3 AND user_id = $4', [
          newName,
          parsed.data.color ?? null,
          id,
          req.userId,
        ]);
      } catch (err) {
        // 23505 = unique violation from categories_user_name_lower_idx (case-insensitive, per user).
        if ((err as { code?: string }).code === '23505') {
          await client.query('ROLLBACK');
          res.status(409).json({ error: `A category named "${newName}" already exists` });
          return;
        }
        throw err;
      }

      if (renaming) {
        await client.query('UPDATE expenses SET category = $1 WHERE category = $2 AND user_id = $3', [newName, oldName, req.userId]);
        await client.query('UPDATE merchant_rules SET category = $1 WHERE category = $2 AND user_id = $3', [newName, oldName, req.userId]);
      }
      await client.query('COMMIT');

      const updated = await pool.query('SELECT id, name, color, is_default FROM categories WHERE id = $1 AND user_id = $2', [id, req.userId]);
      res.status(200).json(updated.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no output. (`expenses.ts` still calls `finalizeCategory` with four arguments, which is valid because the fifth is optional.)

- [ ] **Step 5: Commit**

```bash
git add src/services/categorizationFinalizer.ts src/services/createManualExpense.ts src/routes/categories.ts
git commit -m "feat: make categories per user

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Move every route to `requireUser`, and remove the API key

**Files:**
- Modify: `src/routes/expenses.ts`
- Rewrite: `src/routes/rules.ts`
- Rewrite: `src/routes/push.ts`
- Modify: `src/routes/webhook.ts`
- Modify: `src/services/pushNotifications.ts`
- Modify: `src/constants.ts`
- Delete: `src/middleware/requireApiKey.ts`
- Modify: `.env.example`
- Modify: `docs/moai/specs/2026-10-20-login-multi-user-design.md`

- [ ] **Step 1: Edit `src/routes/expenses.ts` with a script that checks every edit**

Create the file `edit_expenses.py` in the project folder, run it with `python3 edit_expenses.py`, then delete it. It stops with an error if any expected text is missing.

```python
import re

path = 'src/routes/expenses.ts'
s = open(path).read()

def replace_once(text, old, new):
    assert text.count(old) >= 1, f'missing: {old!r}'
    return text.replace(old, new, 1)

# 1. imports
s = replace_once(s, "import { requireApiKey } from '../middleware/requireApiKey';",
                    "import { requireUser } from '../middleware/requireUser';")
s = replace_once(s, "import { DEMO_USER_ID, categorizationTimeoutMs } from '../constants';",
                    "import { categorizationTimeoutMs } from '../constants';")

# 2. the two GET routes had no protection at all
s = replace_once(s, "expensesRouter.get(\n  '/',\n  asyncHandler(",
                    "expensesRouter.get(\n  '/',\n  requireUser,\n  asyncHandler(")
s = replace_once(s, "expensesRouter.get(\n  '/:id',\n  asyncHandler(",
                    "expensesRouter.get(\n  '/:id',\n  requireUser,\n  asyncHandler(")

# 3. every write route
count = s.count('\n  requireApiKey,\n')
assert count == 4, f'expected 4 requireApiKey uses, found {count}'
s = s.replace('\n  requireApiKey,\n', '\n  requireUser,\n')

# 4. the user id comes from the session now
assert 'DEMO_USER_ID' in s
s = s.replace('DEMO_USER_ID', 'req.userId')

# 5. /:id/categorize must only touch the signed-in user's expense.
#    The same finalizeCategory line also appears in the phone-alert route, so change the FIRST one only.
old = "const { applied, category } = await finalizeCategory(pool, id, parsed.data.category, 'user');"
new = "const { applied, category } = await finalizeCategory(pool, id, parsed.data.category, 'user', req.userId);"
s = replace_once(s, old, new)
s = replace_once(s, "const existing = await pool.query('SELECT status FROM expenses WHERE id = $1', [id]);",
                    "const existing = await pool.query('SELECT status FROM expenses WHERE id = $1 AND user_id = $2', [id, req.userId]);")

open(path, 'w').write(s)
print('ok')
```

Run: `python3 edit_expenses.py && rm edit_expenses.py`
Expected: `ok`.

- [ ] **Step 2: Rewrite `src/routes/rules.ts`**

```ts
import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { requireUser } from '../middleware/requireUser';

export const rulesRouter = Router();

// What the app has learned: one row per merchant the user has categorized.
rulesRouter.get(
  '/',
  requireUser,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT merchant_key, category FROM merchant_rules WHERE user_id = $1 ORDER BY merchant_key`,
      [req.userId],
    );
    res.status(200).json(result.rows);
  }),
);

// Forgets one rule; that merchant goes back to the built-in guess.
// The key is URL-encoded by the client because it can contain spaces/Thai text.
rulesRouter.delete(
  '/:key',
  requireUser,
  asyncHandler(async (req, res) => {
    const result = await pool.query('DELETE FROM merchant_rules WHERE user_id = $1 AND merchant_key = $2', [
      req.userId,
      req.params.key,
    ]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    res.status(204).end();
  }),
);
```

- [ ] **Step 3: Rewrite `src/routes/push.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { requireUser } from '../middleware/requireUser';
import { vapidPublicKey } from '../services/pushNotifications';

export const pushRouter = Router();

const SubscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
});

// The browser needs this public key to create a subscription tied to this server.
// It is public on purpose: it is not a secret.
pushRouter.get('/public-key', (_req, res) => {
  const key = vapidPublicKey();
  if (!key) {
    res.status(503).json({ error: 'Push notifications are not configured on the server' });
    return;
  }
  res.status(200).json({ key });
});

// A device (endpoint) belongs to whoever subscribed last on it.
pushRouter.post(
  '/subscribe',
  requireUser,
  asyncHandler(async (req, res) => {
    const parsed = SubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid subscription' });
      return;
    }
    const { endpoint, keys } = parsed.data;
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [endpoint, req.userId, keys.p256dh, keys.auth],
    );
    res.status(201).json({ subscribed: true });
  }),
);

pushRouter.post(
  '/unsubscribe',
  requireUser,
  asyncHandler(async (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.userId]);
    res.status(200).json({ subscribed: false });
  }),
);
```

- [ ] **Step 4: Reject unknown users in the webhook route**

In `src/routes/webhook.ts`, add this import after the `ingestTransaction` import:

```ts
import { userExists } from '../services/users';
```

And inside the `try {` block, directly before `const result = await ingestTransaction(pool, {`, add:

```ts
    // The bank names a user. Only ids that have an account are accepted, and an
    // unknown id stores nothing (no ledger row, no expense).
    if (!(await userExists(pool, payload.user_id))) {
      res.status(404).json({ error: 'Unknown user' });
      return;
    }

```

- [ ] **Step 5: Give the phone-alert token its own secret**

In `src/services/pushNotifications.ts`, replace:

```ts
// The notification's buttons are clicked inside a service worker, which can't
// see the dashboard's API key. So each push carries a token that is valid for
// exactly one thing: categorizing THAT expense. It's an HMAC of the expense id,
// so it can't be forged or reused on another expense, and the route also
// refuses anything that isn't still pending.
function tokenSecret(): string {
  return `notification-token:${process.env.DASHBOARD_API_KEY ?? ''}`;
}
```

with:

```ts
// The notification's buttons are clicked inside a service worker, which has no
// signed-in session. So each push carries a token that is valid for exactly one
// thing: categorizing THAT expense. It's an HMAC of the expense id, so it can't
// be forged or reused on another expense, and the route also refuses anything
// that isn't still pending. NOTIFICATION_SECRET (in .env) is the HMAC key.
function tokenSecret(): string {
  const secret = process.env.NOTIFICATION_SECRET;
  if (!secret) throw new Error('NOTIFICATION_SECRET is not configured');
  return `notification-token:${secret}`;
}
```

- [ ] **Step 6: Remove the demo user and the API key**

Replace the whole of `src/constants.ts` with:

```ts
// Read lazily (not at import time): dotenv.config() runs in server.ts AFTER
// the imports are evaluated, so a module-level read would miss .env values.
export function categorizationTimeoutMs(): number {
  return process.env.CATEGORIZATION_TIMEOUT_MS ? Number(process.env.CATEGORIZATION_TIMEOUT_MS) : 30_000;
}
```

Run: `git rm src/middleware/requireApiKey.ts`

In `.env.example`, replace these lines:

```
# Required by the dashboard's own mutating endpoints (simulate transaction,
# categorize, delete category) — sent as the `x-api-key` header.
DASHBOARD_API_KEY=dev-local-dashboard-key
```

with:

```
# Secret used to sign the phone-alert buttons (one token per expense). Any long
# random string. Generate one with: openssl rand -hex 32
NOTIFICATION_SECRET=change-me-to-a-long-random-string

# Set to false to close sign-up once everyone has an account. The very first
# account can always be created.
ALLOW_SIGNUP=true
```

- [ ] **Step 7: Check nothing still uses the old names**

Run: `grep -rn "DEMO_USER_ID\|requireApiKey\|DASHBOARD_API_KEY" src scripts .env.example`
Expected: no output. (`public/app.js` and `README.md` still mention the API key. Task 8 and Task 10 fix them.)

- [ ] **Step 8: Type-check and run the unit tests**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors, and `# fail 0` with `# pass 43`.

- [ ] **Step 9: Write the two spec updates**

In `docs/moai/specs/2026-10-20-login-multi-user-design.md`, in the "Decisions" table add these two rows after the "New packages" row:

```
| Phone-alert token secret | A new `NOTIFICATION_SECRET` setting in `.env` replaces `DASHBOARD_API_KEY` as the key that signs the per-expense alert token. |
| Pure session helpers | `src/services/sessionToken.ts` holds the token functions that need no database, so they have unit tests. |
```

- [ ] **Step 10: Commit**

```bash
git add -A src .env.example docs/moai/specs/2026-10-20-login-multi-user-design.md
git status --short
git commit -m "feat: require sign-in on every dashboard route and drop the API key

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected from `git status --short` before the commit: only the files listed in this task (and `?? .DS_Store`, which is not added).

---

### Task 8: Frontend (sign-in page, `authFetch`, header)

**Files:**
- Create: `public/login.html`
- Create: `public/auth.js`
- Modify: `public/style.css` (append)
- Modify: `public/index.html` (header)
- Modify: `public/app.js`

- [ ] **Step 1: Create `public/login.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@300;400;500;600&display=swap" rel="stylesheet" />
  <link rel="icon" href="icon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="style.css" />
</head>
<body class="auth-page">
  <main>
    <form id="auth-form" class="auth-card" novalidate>
      <h1 id="auth-title">Sign in</h1>
      <p id="auth-sub" class="auth-sub">Welcome back. Sign in to see your expenses.</p>

      <label class="auth-field">Email
        <input id="auth-email" type="email" autocomplete="username" required />
      </label>
      <label class="auth-field">Password
        <input id="auth-password" type="password" autocomplete="current-password" minlength="8" required />
      </label>
      <label class="auth-remember">
        <input id="auth-remember" type="checkbox" />
        Remember me for 30 days
      </label>

      <p id="auth-error" class="auth-error" role="alert" hidden></p>
      <button id="auth-submit" class="btn auth-submit" type="submit">Sign in</button>
      <p class="auth-switch">
        <span id="auth-switch-text">No account yet?</span>
        <button id="auth-switch-btn" class="link-btn" type="button">Create account</button>
      </p>
    </form>
  </main>
  <script src="auth.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/auth.js`**

```js
const $ = (id) => document.getElementById(id);

const formEl = $('auth-form');
const titleEl = $('auth-title');
const subEl = $('auth-sub');
const emailEl = $('auth-email');
const passwordEl = $('auth-password');
const rememberEl = $('auth-remember');
const errorEl = $('auth-error');
const submitEl = $('auth-submit');
const switchTextEl = $('auth-switch-text');
const switchBtnEl = $('auth-switch-btn');

let mode = 'signin'; // or 'signup'

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function setMode(next) {
  mode = next;
  const signin = mode === 'signin';
  titleEl.textContent = signin ? 'Sign in' : 'Create account';
  subEl.textContent = signin ? 'Welcome back. Sign in to see your expenses.' : 'Use at least 8 characters for the password.';
  submitEl.textContent = signin ? 'Sign in' : 'Create account';
  switchTextEl.textContent = signin ? 'No account yet?' : 'Already have an account?';
  switchBtnEl.textContent = signin ? 'Create account' : 'Sign in';
  passwordEl.autocomplete = signin ? 'current-password' : 'new-password';
  showError('');
}

switchBtnEl.addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  if (!email) return showError('Enter your email.');
  if (mode === 'signup' && password.length < 8) return showError('Use at least 8 characters for the password.');
  if (!password) return showError('Enter your password.');
  showError('');

  submitEl.disabled = true;
  try {
    const res = await fetch(`/api/auth/${mode === 'signin' ? 'login' : 'signup'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember: rememberEl.checked }),
    });
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 400) showError('Enter a valid email and a password of at least 8 characters.');
    else showError(body.error ?? 'Something went wrong. Try again.');
  } catch (err) {
    console.error(err);
    showError('Cannot reach the server. Try again.');
  } finally {
    submitEl.disabled = false;
  }
});

// Already signed in? Go straight to the dashboard.
fetch('/api/auth/me')
  .then((res) => {
    if (res.ok) window.location.href = '/';
  })
  .catch(() => {});
```

- [ ] **Step 3: Append the sign-in styles to `public/style.css`**

```css

/* ---------- sign-in page ---------- */
.auth-page main { max-width: 380px; margin: 12vh auto 0; padding: 0 16px; }
.auth-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
.auth-card h1 { margin: 0 0 4px; font-size: 1.3rem; }
.auth-sub { margin: 0 0 18px; color: var(--muted); font-size: 0.9rem; }
.auth-field { display: block; margin-bottom: 14px; font-size: 0.85rem; color: var(--muted); }
.auth-field input[type="email"], .auth-field input[type="password"] {
  display: block; width: 100%; margin-top: 4px; padding: 8px 10px; font: inherit; color: var(--ink);
  border: 1px solid var(--line-strong); border-radius: 8px; background: var(--paper);
}
.auth-remember { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; font-size: 0.85rem; color: var(--ink); }
.auth-error { margin: 0 0 12px; color: var(--pink); font-size: 0.85rem; }
.auth-submit { width: 100%; padding: 9px 12px; }
.auth-switch { margin: 14px 0 0; text-align: center; font-size: 0.85rem; color: var(--muted); }
.user-email { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 4: Add the email and the sign-out button to the dashboard header**

In `public/index.html`, directly after the line `<span id="status" class="status" role="status"></span>` add:

```html
        <span id="user-email" class="status user-email"></span>
```

And directly after the `simulate-btn` button line add:

```html
        <button id="signout-btn" class="btn-quiet" type="button">Sign out</button>
```

- [ ] **Step 5: Edit `public/app.js` with a script that checks every edit**

Create `edit_app.py` in the project folder, run it with `python3 edit_app.py`, then delete it. It stops with an error if any expected text is missing.

```python
path = 'public/app.js'
s = open(path).read()

def replace_once(text, old, new):
    assert text.count(old) == 1, f'expected exactly one: {old!r} (found {text.count(old)})'
    return text.replace(old, new, 1)

# 1. Replace the whole API-key block (from API_KEY_STORAGE_KEY up to HTML_ESCAPES)
start = s.index("const API_KEY_STORAGE_KEY = 'expense_tracker_api_key';")
end = s.index("const HTML_ESCAPES")
auth_fetch = """// fetch() for every call that needs a signed-in user. The browser sends the
// session cookie by itself. If the session is gone (401) the page goes to the
// sign-in page, and the returned promise never settles so callers do not show
// a confusing error while the page is leaving.
async function authFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    return new Promise(() => {});
  }
  return res;
}

"""
s = s[:start] + auth_fetch + s[end:]

# 2. every protected call uses authFetch
assert 'apiKeyFetch(' in s
s = s.replace('apiKeyFetch(', 'authFetch(')

# 3. the GET calls were public before and are protected now
s = replace_once(s, "const res = await fetch('/api/categories');", "const res = await authFetch('/api/categories');")
s = replace_once(s, "const res = await fetch('/api/rules');", "const res = await authFetch('/api/rules');")
s = replace_once(s, "const res = await fetch(`/api/expenses?${params.toString()}`);", "const res = await authFetch(`/api/expenses?${params.toString()}`);")

# 4. messages that mentioned the API key
s = replace_once(s, "Could not save the category. Check the API key and try again.", "Could not save the category. Try again.")
s = replace_once(s, "Could not change the category. Check the API key and try again.", "Could not change the category. Try again.")
s = replace_once(s, "Could not simulate a payment. Check the API key.", "Could not simulate a payment. Try again.")
s = replace_once(s, "    if (res.status === 401) throw new Error('The API key was not accepted. Try again.');\n", "")

# 5. show the signed-in email and wire the sign-out button, before the first refresh
anchor = "refreshCategories().then(refresh);\nscheduleRefresh();"
user_code = """// ---------- signed-in user ----------

const userEmailEl = $('user-email');
const signoutBtnEl = $('signout-btn');

async function showSignedInUser() {
  // authFetch sends a signed-out visitor to the sign-in page.
  const res = await authFetch('/api/auth/me');
  if (!res.ok) return;
  const me = await res.json();
  userEmailEl.textContent = me.email;
  userEmailEl.title = me.email;
}

signoutBtnEl.addEventListener('click', async () => {
  signoutBtnEl.disabled = true;
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login.html';
  }
});

showSignedInUser();

"""
s = replace_once(s, anchor, user_code + anchor)

open(path, 'w').write(s)
print('ok')
```

Run: `python3 edit_app.py && rm edit_app.py`
Expected: `ok`.

- [ ] **Step 6: Static checks**

Run each and compare:

```bash
node --check public/app.js && node --check public/auth.js && echo SYNTAX_OK
grep -n "apiKeyFetch\|getApiKey\|API_KEY\|api key\|API key" public/app.js
grep -c "authFetch(" public/app.js
for id in auth-form auth-title auth-sub auth-email auth-password auth-remember auth-error auth-submit auth-switch-text auth-switch-btn; do printf '%s ' $id; grep -c "id=\"$id\"" public/login.html; done
for id in user-email signout-btn; do printf '%s ' $id; grep -c "id=\"$id\"" public/index.html; done
```

Expected: `SYNTAX_OK`; no output from the second command; the third prints a number greater than 10; every `id` line ends with `1`.

- [ ] **Step 7: Commit**

```bash
git add public/login.html public/auth.js public/style.css public/index.html public/app.js
git commit -m "feat: add sign-in page, authFetch and sign-out button

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end smoke script, run against the test database

**Files:**
- Create: `scripts/authSmoke.ts`

- [ ] **Step 1: Write `scripts/authSmoke.ts`**

```ts
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

// Checks sign-in, per-user data and the bank webhook against a running server.
// Run it only against the TEST server and TEST database (see the plan).
const BASE = process.argv[2] ?? 'http://localhost:3002';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

interface Res {
  status: number;
  body: any;
  setCookie: string[];
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const payload = options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined);
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  if (options.cookie) headers['Cookie'] = options.cookie;
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body, setCookie: res.headers.getSetCookie() };
}

function cookieOf(res: Res): string {
  const raw = res.setCookie.find((c) => c.startsWith('sid='));
  return raw ? raw.split(';')[0] : '';
}

function sidHeader(res: Res): string {
  return res.setCookie.find((c) => c.startsWith('sid=')) ?? '';
}

async function signedWebhook(userId: string): Promise<Res> {
  const raw = JSON.stringify({
    transaction_id: `smoke_${crypto.randomUUID()}`,
    user_id: userId,
    amount: 120,
    currency: 'THB',
    merchant_name: 'STARBUCKS STORE 101',
    bank_category: 'STARBUCKS_STORE_101',
    timestamp: new Date().toISOString(),
  });
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return call('POST', '/api/webhooks/bank-sync', { raw, headers: { 'X-Bank-Signature': signature } });
}

async function main() {
  const suffix = crypto.randomBytes(3).toString('hex');
  const emailA = `a-${suffix}@example.com`;
  const emailB = `b-${suffix}@example.com`;
  const password = 'correct horse battery';

  console.log(`Smoke test against ${BASE}\n`);

  // --- signed out ---
  for (const path of ['/api/expenses', '/api/categories', '/api/rules', '/api/auth/me']) {
    const res = await call('GET', path);
    check(`GET ${path} without a cookie gives 401`, res.status === 401, res.status);
  }
  check('POST /api/push/subscribe without a cookie gives 401', (await call('POST', '/api/push/subscribe', { body: {} })).status === 401);
  check('POST /api/expenses without a cookie gives 401', (await call('POST', '/api/expenses', { body: {} })).status === 401);

  // --- webhook before any account exists ---
  check('webhook for usr_demo_1 gives 404 before the first account', (await signedWebhook('usr_demo_1')).status === 404);
  check('webhook for an unknown user gives 404', (await signedWebhook('usr_nobody')).status === 404);

  // --- first account takes over usr_demo_1 ---
  const signupA = await call('POST', '/api/auth/signup', { body: { email: emailA, password, remember: true } });
  check('first sign-up gives 201', signupA.status === 201, signupA);
  check('first account has the id usr_demo_1', signupA.body?.id === 'usr_demo_1', signupA.body);
  check('remember me sets Max-Age=2592000', sidHeader(signupA).includes('Max-Age=2592000'), sidHeader(signupA));
  check('cookie is HttpOnly and SameSite=Lax', sidHeader(signupA).includes('HttpOnly') && sidHeader(signupA).includes('SameSite=Lax'), sidHeader(signupA));
  const cookieA = cookieOf(signupA);

  const meA = await call('GET', '/api/auth/me', { cookie: cookieA });
  check('/me returns the first user', meA.status === 200 && meA.body?.id === 'usr_demo_1' && meA.body?.email === emailA, meA);

  const listA = await call('GET', '/api/expenses?range=year', { cookie: cookieA });
  check('first account sees exactly the legacy expense', listA.body?.expenses?.length === 1 && listA.body.expenses[0].merchant === 'LEGACY TEST Coffee', listA.body?.expenses?.map((e: any) => e.merchant));
  const rulesA = await call('GET', '/api/rules', { cookie: cookieA });
  check('first account has the legacy learned rule', rulesA.body?.length === 1 && rulesA.body[0].merchant_key === 'legacy test coffee', rulesA.body);
  const catsA = await call('GET', '/api/categories', { cookie: cookieA });
  check('first account has Food, Other, Transport', JSON.stringify((catsA.body ?? []).map((c: any) => c.name).sort()) === JSON.stringify(['Food', 'Other', 'Transport']), catsA.body);

  // --- second account starts empty ---
  const signupB = await call('POST', '/api/auth/signup', { body: { email: emailB, password } });
  check('second sign-up gives 201', signupB.status === 201, signupB);
  check('second account has a random id', /^usr_[0-9a-f]{8}$/.test(signupB.body?.id ?? ''), signupB.body);
  check('no remember me gives a cookie without Max-Age', !sidHeader(signupB).includes('Max-Age'), sidHeader(signupB));
  const cookieB = cookieOf(signupB);

  const listB = await call('GET', '/api/expenses?range=year', { cookie: cookieB });
  check('second account sees no expenses', listB.body?.expenses?.length === 0, listB.body?.expenses?.length);
  check('second account has no learned rules', (await call('GET', '/api/rules', { cookie: cookieB })).body?.length === 0);
  const catsB = await call('GET', '/api/categories', { cookie: cookieB });
  check('second account has the 3 default categories', JSON.stringify((catsB.body ?? []).map((c: any) => c.name).sort()) === JSON.stringify(['Food', 'Other', 'Transport']), catsB.body);

  // --- sign-up rules ---
  const dup = await call('POST', '/api/auth/signup', { body: { email: emailA.toUpperCase(), password } });
  check('same email in capitals gives 409', dup.status === 409, dup.status);
  check('invalid email gives 400', (await call('POST', '/api/auth/signup', { body: { email: 'nope', password } })).status === 400);
  check('short password gives 400', (await call('POST', '/api/auth/signup', { body: { email: `c-${suffix}@example.com`, password: '1234567' } })).status === 400);

  // --- login ---
  const wrongPassword = await call('POST', '/api/auth/login', { body: { email: emailA, password: 'not the password' } });
  const unknownEmail = await call('POST', '/api/auth/login', { body: { email: `nobody-${suffix}@example.com`, password } });
  check('wrong password gives 401', wrongPassword.status === 401, wrongPassword.status);
  check('unknown email gives the same 401 and message', unknownEmail.status === 401 && unknownEmail.body?.error === wrongPassword.body?.error, [unknownEmail.status, unknownEmail.body, wrongPassword.body]);
  const loginA = await call('POST', '/api/auth/login', { body: { email: emailA, password } });
  check('right password gives 200', loginA.status === 200, loginA.status);
  check('login without remember me has no Max-Age', !sidHeader(loginA).includes('Max-Age'), sidHeader(loginA));
  const loginCookieA = cookieOf(loginA);

  // --- one user cannot reach another user's data ---
  const manualA = await call('POST', '/api/expenses', { cookie: cookieA, body: { merchant: 'ISO A Lunch', amount: 50, category: 'ISO Test Cat' } });
  check('user A adds a manual expense', manualA.status === 201, manualA);
  const idA = manualA.body?.id;
  check('user A can read it', (await call('GET', `/api/expenses/${idA}`, { cookie: cookieA })).status === 200);
  check('user B gets 404 reading it', (await call('GET', `/api/expenses/${idA}`, { cookie: cookieB })).status === 404);
  check('user B gets 404 categorizing it', (await call('POST', `/api/expenses/${idA}/categorize`, { cookie: cookieB, body: { category: 'Food' } })).status === 404);
  check('user B gets 404 recategorizing it', (await call('PATCH', `/api/expenses/${idA}/category`, { cookie: cookieB, body: { category: 'Food' } })).status === 404);

  const manualB = await call('POST', '/api/expenses', { cookie: cookieB, body: { merchant: 'ISO B Lunch', amount: 60, category: 'ISO Test Cat' } });
  check('user B adds a manual expense with the same category name', manualB.status === 201, manualB);

  const catsA2 = await call('GET', '/api/categories', { cookie: cookieA });
  const isoA = (catsA2.body ?? []).find((c: any) => c.name === 'ISO Test Cat');
  check('user A has the new category', !!isoA, catsA2.body);
  check('user B cannot delete user A\'s category (404)', (await call('DELETE', `/api/categories/${isoA?.id}`, { cookie: cookieB })).status === 404);
  const rename = await call('PATCH', `/api/categories/${isoA?.id}`, { cookie: cookieA, body: { name: 'ISO Renamed' } });
  check('user A renames the category', rename.status === 200, rename);
  const listB2 = await call('GET', '/api/expenses?range=year', { cookie: cookieB });
  const isoBRow = (listB2.body?.expenses ?? []).find((e: any) => e.merchant === 'ISO B Lunch');
  check('the rename did not touch user B\'s expense', isoBRow?.category === 'ISO Test Cat', isoBRow);
  const catsB2 = await call('GET', '/api/categories', { cookie: cookieB });
  check('user B still has ISO Test Cat', (catsB2.body ?? []).some((c: any) => c.name === 'ISO Test Cat'), catsB2.body);

  // --- bank webhook ---
  const hook = await signedWebhook('usr_demo_1');
  check('webhook for usr_demo_1 gives 200 pending', hook.status === 200 && hook.body?.status === 'pending', hook);
  const hookId = hook.body?.expense_id;
  const listA3 = await call('GET', '/api/expenses?range=day', { cookie: cookieA });
  check('user A sees the webhook expense', (listA3.body?.expenses ?? []).some((e: any) => String(e.id) === String(hookId)));
  const listB3 = await call('GET', '/api/expenses?range=day', { cookie: cookieB });
  check('user B does not see it', !(listB3.body?.expenses ?? []).some((e: any) => String(e.id) === String(hookId)));
  check('user B cannot categorize it (404)', (await call('POST', `/api/expenses/${hookId}/categorize`, { cookie: cookieB, body: { category: 'Food' } })).status === 404);
  check('user A can categorize it', (await call('POST', `/api/expenses/${hookId}/categorize`, { cookie: cookieA, body: { category: 'Food' } })).status === 200);

  // --- rate limit (an email that has no account, so no other check is affected) ---
  const limitEmail = `limit-${suffix}@example.com`;
  const attempts: number[] = [];
  for (let i = 0; i < 6; i++) {
    attempts.push((await call('POST', '/api/auth/login', { body: { email: limitEmail, password: 'wrong password' } })).status);
  }
  check('5 failed logins give 401 and the 6th gives 429', JSON.stringify(attempts) === JSON.stringify([401, 401, 401, 401, 401, 429]), attempts);

  // --- logout ---
  const logout = await call('POST', '/api/auth/logout', { cookie: loginCookieA });
  check('logout gives 200 and clears the cookie', logout.status === 200 && sidHeader(logout).includes('Max-Age=0'), sidHeader(logout));
  check('the old cookie gives 401 after logout', (await call('GET', '/api/auth/me', { cookie: loginCookieA })).status === 401);
  check('a different session of the same user still works', (await call('GET', '/api/auth/me', { cookie: cookieA })).status === 200);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Reset and fill the test database, then start the test server**

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_test -v ON_ERROR_STOP=1 -q < scripts/fixtures/reset_test_db.sql
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker_test -v ON_ERROR_STOP=1 -q < scripts/fixtures/legacy_demo_data.sql
```

Start the test server in the background (see "Read this first") and wait for `{"ok":true}` from `http://localhost:3002/health`.

- [ ] **Step 4: Run the smoke script**

Run: `npx tsx scripts/authSmoke.ts http://localhost:3002`
Expected: every line starts with `PASS`, and the last line is `All checks passed.` Exit code 0.

If a check fails, read its `->` detail, find the cause in the code (do not weaken the check), fix it in the file that owns the behaviour, reset the test database (Step 3, both commands, the server can stay running), and run the script again. Commit each fix on its own with a message that names it.

- [ ] **Step 5: Check the sign-up switch**

Stop the test server. Start it again with `ALLOW_SIGNUP=false` in the command (replace `ALLOW_SIGNUP=true`). The test database already has users from the smoke run. Run:

```bash
curl -s -i -X POST http://localhost:3002/api/auth/signup -H 'Content-Type: application/json' -d '{"email":"closed@example.com","password":"correct horse battery"}'
```

Expected: `HTTP/1.1 403 Forbidden` and `{"error":"Sign-up is closed"}`.

Then empty the users and check the very first account still works: run the reset command from Step 3 (first command only), then repeat the curl above.
Expected: `HTTP/1.1 201 Created` with `"id":"usr_demo_1"`.

- [ ] **Step 6: Stop the test server, reset the test database, and commit**

Stop only the process on port 3002. Run the reset command once more. Then:

```bash
git add scripts/authSmoke.ts
git commit -m "test: add end-to-end smoke script for sign-in and per-user data

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Cut over the real database and server (done with the user)

This task changes the user's real database and restarts their server. The controller does it, not a subagent, and **asks the user to confirm before Step 2**. Nobody types a password for the user: the user creates their own account.

**Files:**
- Modify: `.env` (the user's own file, not committed)
- Modify: `README.md`
- Modify: `/Users/lim/.claude/projects/-Users-lim-Desktop-web-programming-expense-tracker/memory/project_manual_expense_session11.md` (add a login section) and `MEMORY.md`

- [ ] **Step 1: Run the full checks**

Run: `npm test && npx tsc --noEmit`
Expected: `# fail 0` and no type errors.

- [ ] **Step 2: Ask the user to confirm the cut-over**

Say exactly what will happen: stop the server on port 3001, save a backup of the database to a file in their home folder, apply migration 008, add `NOTIFICATION_SECRET` and `ALLOW_SIGNUP` to `.env`, start the new server, and then they create their account. Wait for a clear yes.

- [ ] **Step 3: Stop the old server and save a backup**

```bash
kill $(lsof -tiTCP:3001 -sTCP:LISTEN)
docker compose exec -T postgres pg_dump -U expense_tracker expense_tracker > ~/expense_tracker_before_login.sql
ls -l ~/expense_tracker_before_login.sql
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -t -c "SELECT (SELECT count(*) FROM expenses), (SELECT count(*) FROM categories), (SELECT count(*) FROM merchant_rules), (SELECT count(*) FROM push_subscriptions);"
```

Expected: the backup file is larger than 0 bytes. Write down the four counts (BEFORE). Tell the user the backup file name, so they can delete it when they are happy.

- [ ] **Step 4: Apply migration 008 to the real database**

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -v ON_ERROR_STOP=1 -q < migrations/008_users_sessions_per_user_categories.sql
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -t -c "SELECT (SELECT count(*) FROM expenses), (SELECT count(*) FROM categories), (SELECT count(*) FROM merchant_rules), (SELECT count(*) FROM push_subscriptions), (SELECT count(*) FROM categories WHERE user_id = 'usr_demo_1'), (SELECT count(*) FROM users);"
```

Expected: the first four numbers equal BEFORE, the fifth equals the categories count, and users is `0`. If the migration fails, nothing changed (it is one transaction). Stop and report. To restore the old state if needed: the backup file holds everything.

- [ ] **Step 5: Add the new settings to `.env`**

```bash
printf '\nNOTIFICATION_SECRET=%s\nALLOW_SIGNUP=true\n' "$(openssl rand -hex 32)" >> .env
cut -d= -f1 .env
```

Expected: the list of setting names now includes `NOTIFICATION_SECRET` and `ALLOW_SIGNUP`. Do not print the values. Tell the user that the old `DASHBOARD_API_KEY` line is no longer used and can be deleted from `.env`.

- [ ] **Step 6: Start the new server**

Run `npm run dev` in the background. Then:

```bash
curl -s http://localhost:3001/health
curl -s -o /dev/null -w 'login page -> %{http_code}\n' http://localhost:3001/login.html
curl -s -o /dev/null -w 'list without sign-in -> %{http_code}\n' http://localhost:3001/api/expenses
```

Expected: `{"ok":true}`, `login page -> 200`, `list without sign-in -> 401`.

- [ ] **Step 7: The user creates the first account**

Tell the user to open `http://localhost:3001/login.html`, choose "Create account", enter their own email and password, and tick "Remember me" if they want. Do not enter anything for them. After they confirm it worked, check:

```bash
docker compose exec -T postgres psql -U expense_tracker -d expense_tracker -t -c "SELECT id, email FROM users;"
```

Expected: one row with the id `usr_demo_1` and the user's email. Ask the user to confirm the dashboard shows all their old expenses (the same count as BEFORE for the year range), their categories, and their learned rules.

- [ ] **Step 8: Update the README**

In `README.md`, add a short section "Signing in" that says:
- Open `http://localhost:3001/login.html` and create an account. The first account keeps all existing data.
- `ALLOW_SIGNUP=false` in `.env` closes sign-up once everyone has an account.
- `NOTIFICATION_SECRET` in `.env` signs the phone-alert buttons. Generate one with `openssl rand -hex 32`.
- The bank webhook `user_id` must be the id of an existing user (`usr_demo_1` for the first account).

Also remove any sentence in the README that tells the reader to set or enter `DASHBOARD_API_KEY`. Run `grep -n -i "api key\|DASHBOARD_API_KEY" README.md` and expect no output afterwards.

- [ ] **Step 9: Update the project memory**

Add a "Login (2026-10-20)" section to `project_manual_expense_session11.md` and one line to `MEMORY.md` (see `feedback_session_continuity.md`). Record: sessions in cookies, `usr_demo_1` is the first account, per-user categories, `NOTIFICATION_SECRET` and `ALLOW_SIGNUP`, the test database `expense_tracker_test` with the reset and fixture scripts and `scripts/authSmoke.ts`, the backup file path, the roadmap (B edit and delete, C income and balance, D budgets and alerts, E period comparison), and the deferred code-review fixes.

- [ ] **Step 10: Commit**

```bash
git add README.md
git commit -m "docs: describe sign-in and the new settings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| `users`, `sessions`, per-user `categories`, indexes | 1 |
| Existing data stays with `usr_demo_1`, no row moves | 1 (migration), 4 (`FIRST_USER_ID`), 9 (claim checks), 10 |
| scrypt, random salt, same password gives different hash, `timingSafeEqual` | 2 |
| Session token, only the hash stored, 12 hour and 30 day lifetimes | 2, 4 |
| Cookie flags, `Max-Age` only with remember me | 3, 5 |
| Login rate limit (5 failures, 15 minutes, `429`) | 3, 5, 9 |
| Sign-up rules, `ALLOW_SIGNUP`, first account always allowed | 5, 9 (Step 5) |
| Same error for wrong email and wrong password | 5, 9 |
| `requireUser` replaces `requireApiKey`, `req.userId` everywhere | 4, 6, 7 |
| List, categories and rules routes need sign-in | 6, 7, 9 |
| Per-user categories, rename scoped to the user | 6, 9 |
| `finalizeCategory` reads the user from the row, foreign id is `404` | 6, 7, 9 |
| Webhook unknown user gives `404`, nothing stored | 7, 9 |
| Webhook HMAC, alert token, sweep unchanged | 7 (token secret only changes the key source) |
| Sign-in page, `authFetch`, email and sign out in the header, API key prompt removed | 8 |
| `.env.example` and `README` updates | 7, 10 |
| Test database, unit tests, API checks, migration check on a copy, browser check | 1, 2, 3, 9, 10 |

Gaps: the browser check of the sign-in page (private window with a second account, redirect when signed out) is done by the user in Task 10 Step 7 and by the controller with the Chrome tools after Task 10 if the user agrees. Out-of-scope items stay out.

**Placeholder scan:** no "TBD" or "add validation" steps. The only values written by the reader are the BEFORE counts, and each step says where they come from.

**Type consistency:** `registerCategory(client, userId, name)` (Task 6) is used with that signature in `createManualExpense` (Task 6) and `recategorizeExpense` / `finalizeCategory` (Task 6). `finalizeCategory(..., ownerUserId?)` is called with `req.userId` in Task 7 and without it by the sweep and the phone-alert route. `buildSessionCookie(token, { maxAgeSeconds, secure })`, `createSession(...)` returning `{ token, maxAgeSeconds }`, and `createLoginRateLimiter({...})` match between Tasks 3, 4 and 5. `req.userId` and `req.userEmail` are declared in Task 4 and used in Tasks 5, 6 and 7.
