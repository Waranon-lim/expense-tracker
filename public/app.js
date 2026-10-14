const REFRESH_INTERVAL_MS = 3000;
const SEARCH_DEBOUNCE_MS = 300;
const BANGKOK_TIME_ZONE = 'Asia/Bangkok';
const CUSTOM_PILL = '__custom__';
const MAX_CATEGORY_BARS = 6;

// Master category list fetched from /api/categories: [{id, name, color, is_default}].
let allCategories = [];

// Matches the server's src/services/categoryColor.ts — only a fallback for a
// category deleted from the master list after being applied to an expense.
function fallbackColorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360}, 65%, 45%)`;
}

const API_KEY_STORAGE_KEY = 'expense_tracker_api_key';

// The dashboard's own mutating endpoints (simulate/categorize/delete-category)
// require the same shared key configured server-side as DASHBOARD_API_KEY.
// Prompt for it once and cache in localStorage rather than baking it into
// this static file — it's a single-user local tool, not a login system.
function getApiKey() {
  let key = null;
  try {
    key = localStorage.getItem(API_KEY_STORAGE_KEY);
  } catch {
    // Storage unavailable (private browsing, etc.) — fall through to prompting.
  }
  if (!key) {
    key = window.prompt('Enter the dashboard API key (server’s DASHBOARD_API_KEY):');
    if (key) {
      try {
        localStorage.setItem(API_KEY_STORAGE_KEY, key);
      } catch {
        // Not fatal — the key still gets sent on this request, just not cached.
      }
    }
  }
  return key;
}

// fetch() wrapper for the API-key-protected endpoints. Clears the cached key
// on a 401 so the next mutating action re-prompts instead of looping on a
// stale/wrong key forever. Also clears it if the key itself is unusable as a
// header value (e.g. it has a non-ASCII character from a stray IME keystroke
// when it was typed in) — fetch() throws synchronously in that case, before
// any request is even sent, so a 401 would never happen to trigger the clear.
async function apiKeyFetch(url, options = {}) {
  const key = getApiKey();
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { ...(options.headers ?? {}), 'x-api-key': key ?? '' },
    });
  } catch (err) {
    try {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    } catch {
      // ignore
    }
    throw err;
  }
  if (res.status === 401) {
    try {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  return res;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Merchant names come from the bank webhook and category names can be typed
// by the user (custom categories) — both are untrusted strings that end up
// interpolated into innerHTML below, so every one of them must go through
// this before rendering.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}


const PENDING_BAR_COLOR = 'var(--pink)';

function colorFor(categoryName) {
  const known = allCategories.find((c) => c.name === categoryName);
  return known ? known.color : fallbackColorForName(categoryName);
}

const $ = (id) => document.getElementById(id);
const listEl = $('expense-list');
const pendingLaneEl = $('pending-lane');
const pendingListEl = $('pending-list');
const emptyMessageEl = $('empty-message');
const statusEl = $('status');
const rangeTabsEl = $('range-tabs');
const searchInputEl = $('search-input');
const categorySelectEl = $('category-select');
const manageCategoriesToggleEl = $('manage-categories-toggle');
const manageCategoriesEl = $('manage-categories');
const refreshBtnEl = $('refresh-btn');
const simulateBtnEl = $('simulate-btn');
const exportBtnEl = $('export-btn');
const overviewAmountEl = $('overview-amount');
const overviewSentenceEl = $('overview-sentence');
const timeChartEl = $('time-chart');
const timeChartTitleEl = $('time-chart-title');
const categoryChartEl = $('category-chart');

let currentRange = 'day';
let currentCategory = '';
let currentSearch = '';
let searchDebounceTimer = null;
let lastExpenses = [];
let previousPendingIds = new Set();
let lastChartSig = '';

// Expense ids with an open "Custom" input. While any are open we skip
// re-rendering the lists on the periodic refresh, otherwise the innerHTML
// rebuild wipes the form (and what the user typed) out from under them.
const openCustomFormIds = new Set();

const RANGE_PHRASE = {
  day: 'today',
  week: 'in the last 7 days',
  month: 'in the last 30 days',
  six_months: 'in the last 6 months',
  year: 'in the last year',
};

// ---------- formatting ----------

function formatBaht(value, { whole = false } = {}) {
  const n = Number(value);
  const digits = whole && Number.isInteger(n) ? 0 : 2;
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function formatAmount(expense) {
  // Intl throws on an unrecognized currency code (the server only checks the
  // length is 3), so fall back to plain text instead of blanking the list.
  try {
    return new Intl.NumberFormat('th-TH', { style: 'currency', currency: expense.currency }).format(Number(expense.amount));
  } catch (err) {
    console.error('Unrecognized currency code:', expense.currency, err);
    return `${Number(expense.amount).toFixed(2)} ${escapeHtml(expense.currency)}`;
  }
}

function bangkokParts(isoString) {
  return new Date(isoString).toLocaleString('en-CA', {
    timeZone: BANGKOK_TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function bangkokDayKey(isoString) {
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: BANGKOK_TIME_ZONE }); // YYYY-MM-DD
}

function formatDayHeading(dayKey) {
  const todayKey = bangkokDayKey(new Date().toISOString());
  const yesterdayKey = bangkokDayKey(new Date(Date.now() - 86_400_000).toISOString());
  if (dayKey === todayKey) return 'Today';
  if (dayKey === yesterdayKey) return 'Yesterday';
  // Noon UTC keeps the weekday stable regardless of the viewer's own timezone.
  return new Date(`${dayKey}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString('en-US', {
    timeZone: BANGKOK_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ---------- pending lane ----------

function renderPendingCard(expense, timing) {
  const remainingMs = Math.max(0, timing.timeoutMs - (timing.serverNow - new Date(expense.received_at).getTime()));
  const fraction = Math.min(1, remainingMs / timing.timeoutMs);
  const expiresAt = Date.now() + remainingMs;

  const pills = allCategories
    .map((c) => {
      const suggested = c.name === expense.suggested_category ? ' suggested' : '';
      return `<button class="category-pill${suggested}" data-id="${expense.id}" data-category="${escapeHtml(c.name)}" type="button">
        <span class="dot" style="background:${c.color}"></span>${escapeHtml(c.name)}</button>`;
    })
    .join('');

  const card = document.createElement('div');
  card.className = 'pending';
  card.dataset.id = expense.id;
  card.innerHTML = `
    <div class="pending-top">
      <span class="merchant">${escapeHtml(expense.merchant)}</span>
      <span class="amount">&minus;${formatAmount(expense)}</span>
    </div>
    <div class="pending-sub">Files as <b>${escapeHtml(expense.suggested_category)}</b> in
      <span class="seconds" data-expires="${expiresAt}">${Math.ceil(remainingMs / 1000)}s</span></div>
    <div class="tap-ui">${pills}<button class="category-pill" data-id="${expense.id}" data-category="${CUSTOM_PILL}" type="button">Custom…</button></div>
    <div class="custom-category-form" data-id="${expense.id}">
      <input type="text" class="custom-category-input" placeholder="Category name" maxlength="40" aria-label="Custom category name" />
      <button class="custom-category-submit" data-id="${expense.id}" type="button">Save</button>
    </div>
    <div class="countdown" aria-hidden="true"><span style="--from:${fraction};animation-duration:${remainingMs}ms"></span></div>
  `;
  return card;
}

function wirePendingEvents() {
  pendingListEl.querySelectorAll('.category-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      const { id, category } = pill.dataset;
      if (category === CUSTOM_PILL) {
        const form = pendingListEl.querySelector(`.custom-category-form[data-id="${id}"]`);
        form.classList.toggle('visible');
        if (form.classList.contains('visible')) {
          openCustomFormIds.add(id);
          form.querySelector('.custom-category-input').focus();
        } else {
          openCustomFormIds.delete(id);
        }
        return;
      }
      categorize(id, category, pill.closest('.pending'));
    });
  });

  pendingListEl.querySelectorAll('.custom-category-form').forEach((form) => {
    const submit = () => {
      const category = form.querySelector('.custom-category-input').value.trim();
      if (category) categorize(form.dataset.id, category, form.closest('.pending'));
    };
    form.querySelector('.custom-category-submit').addEventListener('click', submit);
    form.querySelector('.custom-category-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  });
}

async function categorize(id, category, scope) {
  // Whatever path got us here, this expense is no longer "being edited".
  openCustomFormIds.delete(String(id));
  scope.querySelectorAll('button').forEach((el) => {
    el.disabled = true;
  });

  try {
    const res = await apiKeyFetch(`/api/expenses/${id}/categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`Categorize failed: ${res.status}`);
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Could not save the category. Check the API key and try again.';
  } finally {
    // The timeout sweep can beat the tap, so always re-fetch the real state.
    await refreshCategories();
    await refresh();
  }
}

// Ticks the "in 18s" text once a second. The bar itself is pure CSS; this only
// updates text. Self-rescheduling setTimeout, same reason as the refresh loop.
function tickCountdownText() {
  document.querySelectorAll('.seconds').forEach((el) => {
    const left = Math.max(0, Math.ceil((Number(el.dataset.expires) - Date.now()) / 1000));
    el.textContent = `${left}s`;
  });
  setTimeout(tickCountdownText, 1000);
}

// ---------- ledger ----------

function renderRow(expense) {
  const color = colorFor(expense.category);
  const row = document.createElement('div');
  row.className = 'expense-row';
  if (previousPendingIds.has(String(expense.id))) row.classList.add('just-settled');
  row.innerHTML = `
    <div class="expense-main">
      <div class="merchant">${escapeHtml(expense.merchant)}</div>
      <div class="meta-row"><span class="dot" style="background:${color}"></span>${escapeHtml(expense.category)}
        <span aria-hidden="true">&middot;</span> ${formatTime(expense.received_at)}</div>
    </div>
    <div class="expense-amount">&minus;${formatAmount(expense)}</div>
  `;
  return row;
}

function renderLedger(settled) {
  listEl.innerHTML = '';
  let currentDay = null;
  let dayTotals = new Map();
  for (const e of settled) {
    const key = bangkokDayKey(e.received_at);
    dayTotals.set(key, (dayTotals.get(key) ?? 0) + Number(e.amount));
  }
  for (const expense of settled) {
    const key = bangkokDayKey(expense.received_at);
    if (key !== currentDay) {
      currentDay = key;
      const head = document.createElement('div');
      head.className = 'day-head';
      head.innerHTML = `<span>${formatDayHeading(key)}</span><span>${formatBaht(dayTotals.get(key))}</span>`;
      listEl.appendChild(head);
    }
    listEl.appendChild(renderRow(expense));
  }
}

function renderLists(expenses, timing) {
  if (openCustomFormIds.size > 0) return; // don't clobber an in-progress form

  const pending = expenses.filter((e) => e.status === 'pending');
  const settled = expenses.filter((e) => e.status !== 'pending');

  pendingLaneEl.hidden = pending.length === 0;
  pendingListEl.innerHTML = '';
  for (const e of pending) pendingListEl.appendChild(renderPendingCard(e, timing));
  wirePendingEvents();

  renderLedger(settled);
  emptyMessageEl.hidden = expenses.length > 0;

  previousPendingIds = new Set(pending.map((e) => String(e.id)));
}

// ---------- overview ----------

function renderOverview(summary) {
  overviewAmountEl.textContent = formatBaht(summary.total, { whole: true });
  const when = RANGE_PHRASE[currentRange];
  if (summary.count === 0) {
    overviewSentenceEl.textContent = `No payments ${when}.`;
    return;
  }
  const noun = summary.count === 1 ? 'payment' : 'payments';
  const top = summary.topCategory ? `, mostly ${summary.topCategory}` : '';
  overviewSentenceEl.textContent = `${summary.count} ${noun} ${when}${top}`;
}

// ---------- charts ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

function bucketLabel(key, granularity) {
  if (granularity === 'hour') return `${key.slice(11, 13)}:00`;
  if (granularity === 'day') {
    return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  }
  return new Date(`${key}-01T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: '2-digit' });
}

function shortTick(key, granularity) {
  if (granularity === 'hour') return key.slice(11, 13);
  if (granularity === 'day') return String(Number(key.slice(8, 10)));
  return new Date(`${key}-01T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
}

// A round ceiling for the y-axis (1, 2, 5 × 10^n) so the single gridline reads cleanly.
function niceCeil(max) {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const f = max / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

function renderTimeChart(chart) {
  const { granularity, buckets } = chart;
  const noun = { hour: 'hour', day: 'day', month: 'month' }[granularity];
  timeChartTitleEl.textContent = `Spending by ${noun}`;

  const max = Math.max(...buckets.map((b) => b.total), 0);
  if (max === 0) {
    timeChartEl.innerHTML = '<p class="empty-state">Nothing spent in this range yet.</p>';
    return;
  }

  const W = 660;
  const H = 168;
  const top = 16;
  const bottom = 22;
  const plotH = H - top - bottom;
  const ceil = niceCeil(max);
  const n = buckets.length;
  const slot = W / n;
  const barW = Math.min(slot * 0.62, 26);
  const tickEvery = Math.ceil(n / 8);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Bar chart of spending by ${noun}. Peak ${formatBaht(max)}.`);

  const line = (cls, y) => {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('class', cls);
    l.setAttribute('x1', 0);
    l.setAttribute('x2', W);
    l.setAttribute('y1', y);
    l.setAttribute('y2', y);
    svg.appendChild(l);
  };
  const text = (str, x, y, anchor) => {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    t.setAttribute('text-anchor', anchor);
    t.textContent = str;
    svg.appendChild(t);
  };

  line('grid', top);
  text(formatBaht(ceil, { whole: true }), 0, top - 5, 'start');

  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  tooltip.hidden = true;

  buckets.forEach((b, i) => {
    const cx = slot * i + slot / 2;
    const h = (b.total / ceil) * plotH;
    const y = top + plotH - h;

    if (b.total > 0) {
      const r = Math.min(3, h);
      const bar = document.createElementNS(SVG_NS, 'path');
      bar.setAttribute('class', 'bar');
      bar.setAttribute('d', `M${cx - barW / 2},${top + plotH} V${y + r} Q${cx - barW / 2},${y} ${cx - barW / 2 + r},${y} H${cx + barW / 2 - r} Q${cx + barW / 2},${y} ${cx + barW / 2},${y + r} V${top + plotH} Z`);
      svg.appendChild(bar);
      b.el = bar;
    }
    if (i % tickEvery === 0) text(shortTick(b.key, granularity), cx, H - 5, 'middle');

    const hit = document.createElementNS(SVG_NS, 'rect');
    hit.setAttribute('class', 'hit');
    hit.setAttribute('x', slot * i);
    hit.setAttribute('y', 0);
    hit.setAttribute('width', slot);
    hit.setAttribute('height', H);
    hit.addEventListener('mouseenter', () => {
      b.el?.classList.add('hot');
      tooltip.innerHTML = `${formatBaht(b.total)}<small>${bucketLabel(b.key, granularity)}</small>`;
      tooltip.style.left = `${(cx / W) * 100}%`;
      tooltip.style.top = `${(Math.min(y, top + plotH - 4) / H) * 100}%`;
      tooltip.hidden = false;
    });
    hit.addEventListener('mouseleave', () => {
      b.el?.classList.remove('hot');
      tooltip.hidden = true;
    });
    svg.appendChild(hit);
  });
  line('axis', top + plotH);

  // Table view of the same data, for screen readers.
  const table = document.createElement('table');
  table.className = 'sr-only';
  table.innerHTML = `<caption>Spending by ${noun}</caption>${buckets
    .filter((b) => b.total > 0)
    .map((b) => `<tr><th>${bucketLabel(b.key, granularity)}</th><td>${formatBaht(b.total)}</td></tr>`)
    .join('')}`;

  timeChartEl.replaceChildren(svg, tooltip, table);
}

function renderCategoryChart(chart) {
  const rows = chart.byCategory;
  if (rows.length === 0) {
    categoryChartEl.innerHTML = '<p class="empty-state">No categories to show yet.</p>';
    return;
  }
  const grand = rows.reduce((sum, r) => sum + r.total, 0);
  let shown = rows.slice(0, MAX_CATEGORY_BARS);
  const rest = rows.slice(MAX_CATEGORY_BARS);
  if (rest.length > 0) {
    shown = [...shown, { category: 'Everything else', total: rest.reduce((s, r) => s + r.total, 0), count: 0, folded: true }];
  }
  const max = Math.max(...shown.map((r) => r.total));

  categoryChartEl.innerHTML = shown
    .map((r) => {
      const color = r.category === 'Pending' ? PENDING_BAR_COLOR : r.folded ? 'var(--line-strong)' : colorFor(r.category);
      const filterable = r.category !== 'Pending' && !r.folded;
      const pct = Math.round((r.total / grand) * 100);
      return `<button type="button" class="cat-row${filterable ? ' filterable' : ''}" ${filterable ? `data-category="${escapeHtml(r.category)}" title="Show only ${escapeHtml(r.category)}"` : 'disabled'}>
        <span class="cat-name"><span class="dot" style="background:${color}"></span><span>${escapeHtml(r.category)}</span></span>
        <span class="cat-track"><span class="cat-fill" style="display:block;width:${(r.total / max) * 100}%;background:${color}"></span></span>
        <span class="cat-value"><b>${formatBaht(r.total, { whole: true })}</b> ${pct}%</span>
      </button>`;
    })
    .join('');

  categoryChartEl.querySelectorAll('button[data-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentCategory = currentCategory === btn.dataset.category ? '' : btn.dataset.category;
      categorySelectEl.value = currentCategory;
      refresh();
    });
  });
}

// ---------- CSV export ----------

// Spreadsheet apps run text starting with = + - @ as a formula; merchant names
// come from the bank, so neutralize them with a leading apostrophe.
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function exportCsv() {
  const header = ['Date (Bangkok)', 'Merchant', 'Amount', 'Currency', 'Category', 'Status'];
  const rows = lastExpenses.map((e) => [bangkokParts(e.received_at), e.merchant, e.amount, e.currency, e.category ?? '', e.status]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  // The BOM makes Excel read the file as UTF-8, so Thai merchant names survive.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `expenses-${currentRange}-${bangkokDayKey(new Date().toISOString())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- categories ----------

async function refreshCategories() {
  try {
    const res = await fetch('/api/categories');
    if (!res.ok) return;
    allCategories = await res.json();

    const previousValue = categorySelectEl.value;
    categorySelectEl.innerHTML = '<option value="">All categories</option>';
    for (const { name } of allCategories) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      categorySelectEl.appendChild(option);
    }
    const exists = allCategories.some((c) => c.name === previousValue);
    categorySelectEl.value = exists ? previousValue : '';
    currentCategory = exists ? previousValue : '';

    renderManageCategories();
  } catch (err) {
    console.error(err);
  }
}

function renderManageCategories() {
  manageCategoriesEl.innerHTML = allCategories
    .map((c) => {
      const del = c.is_default
        ? ''
        : `<button class="category-chip-delete" data-id="${c.id}" type="button" title="Delete ${escapeHtml(c.name)}" aria-label="Delete category ${escapeHtml(c.name)}">&times;</button>`;
      return `<span class="category-chip" data-name="${escapeHtml(c.name)}"><span class="dot" style="background:${c.color}"></span>${escapeHtml(c.name)}${del}</span>`;
    })
    .join('');

  manageCategoriesEl.querySelectorAll('.category-chip-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await apiKeyFetch(`/api/categories/${btn.dataset.id}`, { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Delete failed: ${res.status}`);
        }
        await refreshCategories();
        await refresh();
      } catch (err) {
        console.error(err);
        statusEl.textContent = `Could not delete category: ${err.message}`;
        btn.disabled = false;
      }
    });
  });
}

// ---------- data loop ----------

async function refresh() {
  try {
    const params = new URLSearchParams({ range: currentRange });
    if (currentCategory) params.set('category', currentCategory);
    if (currentSearch) params.set('q', currentSearch);

    const res = await fetch(`/api/expenses?${params.toString()}`);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const { expenses, summary, chart, timeoutMs, serverNow } = await res.json();

    lastExpenses = expenses;
    renderLists(expenses, { timeoutMs, serverNow: new Date(serverNow).getTime() });
    renderOverview(summary);
    // Skip chart rebuilds when nothing changed, so a hover tooltip isn't
    // torn down by the 3s background refresh.
    const sig = JSON.stringify(chart) + allCategories.length;
    if (sig !== lastChartSig) {
      lastChartSig = sig;
      renderTimeChart(chart);
      renderCategoryChart(chart);
    }
    statusEl.textContent = `Updated ${formatTime(new Date().toISOString())}`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Can’t reach the server. Retrying…';
  }
}

rangeTabsEl.querySelectorAll('.range-tab').forEach((tab) => {
  tab.classList.toggle('active', tab.dataset.range === currentRange);
  tab.setAttribute('aria-pressed', String(tab.dataset.range === currentRange));
  tab.addEventListener('click', async () => {
    if (tab.dataset.range === currentRange) return;
    currentRange = tab.dataset.range;
    rangeTabsEl.querySelectorAll('.range-tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-pressed', String(t === tab));
    });
    await refresh();
  });
});

searchInputEl.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentSearch = searchInputEl.value.trim();
    refresh();
  }, SEARCH_DEBOUNCE_MS);
});

categorySelectEl.addEventListener('change', () => {
  currentCategory = categorySelectEl.value;
  refresh();
});

manageCategoriesToggleEl.addEventListener('click', () => {
  const open = manageCategoriesEl.classList.toggle('visible');
  manageCategoriesToggleEl.setAttribute('aria-expanded', String(open));
});

exportBtnEl.addEventListener('click', exportCsv);

refreshBtnEl.addEventListener('click', async () => {
  refreshBtnEl.classList.add('spinning');
  await refresh();
  setTimeout(() => refreshBtnEl.classList.remove('spinning'), 600);
});

simulateBtnEl.addEventListener('click', async () => {
  simulateBtnEl.disabled = true;
  try {
    const res = await apiKeyFetch('/api/expenses/simulate', { method: 'POST' });
    if (!res.ok) throw new Error(`Simulate failed: ${res.status}`);
    const { merchant } = await res.json();
    statusEl.textContent = `New payment from ${merchant}`;
    await refreshCategories();
    await refresh();
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Could not simulate a payment. Check the API key.';
  } finally {
    simulateBtnEl.disabled = false;
  }
});

// Self-rescheduling setTimeout, not setInterval: a slow refresh can't overlap
// the next tick, since the next is only scheduled after this one finishes.
function scheduleRefresh() {
  setTimeout(async () => {
    await refresh();
    scheduleRefresh();
  }, REFRESH_INTERVAL_MS);
}

refreshCategories().then(refresh);
scheduleRefresh();
tickCountdownText();
