// Service worker: runs in the background even when the dashboard tab is closed.
// It receives the server's push message and shows the phone notification.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function formatAmount(amount, currency) {
  try {
    return new Intl.NumberFormat('th-TH', { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const p = event.data.json();
  event.waitUntil(
    self.registration.showNotification(`${p.merchant}  −${formatAmount(p.amount, p.currency)}`, {
      body: `Tap \u2713 to file as ${p.suggestedCategory}, or tap here to pick another. Otherwise it files as ${p.suggestedCategory} in ${p.timeoutSeconds}s.`,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: `expense-${p.expenseId}`, // a later notification for the same payment replaces this one
      data: p,
      // One button on purpose: Chrome on Android has been seen reporting the wrong
      // action when a notification has several. The button accepts the suggestion;
      // tapping the notification body opens the app to pick any other category.
      actions: [{ action: 'confirm', title: `✓ ${p.suggestedCategory}` }],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const p = n.data;
  n.close();

  if (event.action === 'confirm') {
    // The button was tapped without opening the app: file it from here.
    event.waitUntil(
      fetch(`/api/expenses/${p.expenseId}/categorize-from-notification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-notification-token': p.token },
        body: JSON.stringify({ category: p.suggestedCategory }),
      })
        .then(async (res) => {
          if (!res.ok && res.status !== 409) throw new Error(String(res.status));
          const done = res.ok ? `Filed as ${p.suggestedCategory}` : 'Already filed';
          await self.registration.showNotification(done, { body: p.merchant, tag: n.tag, icon: '/icon.svg', silent: true });
          // Let it show briefly, then clear it so it doesn't pile up.
          await new Promise((r) => setTimeout(r, 3000));
          (await self.registration.getNotifications({ tag: n.tag })).forEach((x) => x.close());
        })
        .catch(() =>
          self.registration.showNotification('Could not file the payment', {
            body: 'Open the app to choose a category.',
            tag: n.tag,
            icon: '/icon.svg',
          }),
        ),
    );
    return;
  }

  // Body tap: open (or focus) the dashboard, where the pending card has all categories.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const existing = wins.find((w) => 'focus' in w);
      return existing ? existing.focus() : self.clients.openWindow('/');
    }),
  );
});
