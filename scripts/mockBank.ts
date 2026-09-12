import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3001';
const WEBHOOK_URL = `${APP_BASE_URL}/api/webhooks/bank-sync`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';

type Mode = 'normal' | 'duplicate' | 'invalid' | 'bad-signature' | 'tap' | 'timeout';

function parseMode(): Mode {
  const flag = process.argv[2];
  if (flag === '--duplicate') return 'duplicate';
  if (flag === '--invalid') return 'invalid';
  if (flag === '--bad-signature') return 'bad-signature';
  if (flag === '--tap') return 'tap';
  if (flag === '--timeout') return 'timeout';
  return 'normal';
}

function buildPayload(overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: `txn_${crypto.randomUUID()}`,
    user_id: 'usr_demo_1',
    amount: 4.75,
    currency: 'USD',
    merchant_name: 'STARBUCKS STORE 101',
    bank_category: 'STARBUCKS_STORE_101',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function sign(rawBody: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

async function send(rawBody: string, signature: string): Promise<{ status: number; body: any }> {
  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bank-Signature': signature,
    },
    body: rawBody,
  });

  const text = await response.text();
  console.log(`-> ${response.status} ${response.statusText}`);
  console.log(text);

  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON response, leave body null
  }
  return { status: response.status, body };
}

async function tapCategory(expenseId: number, category: string) {
  const url = `${APP_BASE_URL}/api/expenses/${expenseId}/categorize`;
  console.log(`Tapping category "${category}" for expense ${expenseId}...`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category }),
  });
  const text = await response.text();
  console.log(`-> ${response.status} ${response.statusText}`);
  console.log(text);
}

async function getExpense(expenseId: number) {
  const url = `${APP_BASE_URL}/api/expenses/${expenseId}`;
  const response = await fetch(url);
  const json = await response.json();
  console.log(`GET /api/expenses/${expenseId} ->`, json);
  return json;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const mode = parseMode();

  if (mode === 'invalid') {
    // Missing required fields (e.g. amount, bank_category) — should be rejected with 400.
    const rawBody = JSON.stringify({ transaction_id: 'txn_invalid', user_id: 'usr_demo_1' });
    console.log('Sending INVALID payload (expect 400)...');
    await send(rawBody, sign(rawBody));
    return;
  }

  if (mode === 'bad-signature') {
    const rawBody = JSON.stringify(buildPayload());
    console.log('Sending payload with a WRONG signature (expect 401)...');
    await send(rawBody, 'deadbeef'.repeat(8));
    return;
  }

  const rawBody = JSON.stringify(buildPayload());
  const signature = sign(rawBody);

  console.log('Sending transaction webhook (expect 200, status: pending)...');
  const { body } = await send(rawBody, signature);

  if (mode === 'duplicate') {
    console.log('Re-sending the SAME payload to simulate at-least-once delivery (expect 200, duplicate_ignored)...');
    await send(rawBody, signature);
    return;
  }

  if (mode === 'tap') {
    await sleep(1000);
    await tapCategory(body.expense_id, 'Coffee Run');
    await getExpense(body.expense_id);
    return;
  }

  if (mode === 'timeout') {
    const waitMs = Number(process.env.CATEGORIZATION_TIMEOUT_MS ?? 30_000) + Number(process.env.CATEGORIZATION_SWEEP_INTERVAL_MS ?? 5_000) + 1000;
    console.log(`Waiting ${waitMs}ms for the timeout sweep to finalize expense ${body.expense_id}...`);
    await sleep(waitMs);
    await getExpense(body.expense_id);
    return;
  }
}

main().catch((err) => {
  console.error('Mock bank script failed:', err);
  process.exit(1);
});
