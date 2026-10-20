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
