import { expect, test, type Page } from '@playwright/test';
import { shows, signInAs } from './helpers';

// Funnel and Costs (R3b-1, screens.md §16-18): a leader sets the target cost per won account to $2,000, adds a
// partner source (a top-level source, so its own Funnel row; a list always sits under a person), sends two accounts
// through its key, assigns one, and adds a $500 Lists and events cost for it. Funnel then shows the source with Sent 2
// and Spend $500, its drill shows Sent 2 and "Too early to judge.", Costs lists it under "Cost by source", and the
// source page's `See in funnel` opens the drill. Names are timestamped and the cost line and the target are put back
// at the end, so the spec can run again on the same data.

const LEADER = 'zach.wiant@taazaa.com';
const AE = 'ash@taazaa.com';

/** A same-origin API call as the signed-in person. */
async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-scout-tenant': 'taazaa' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

test('a source with a cost shows on Funnel, its drill, Costs and its source page', async ({ page, browser }) => {
  const stamp = Date.now();
  const source = `E2E funnel partner ${stamp}`;
  const accounts = [`E2E Funnel One ${stamp}`, `E2E Funnel Two ${stamp}`];
  const note = `E2E funnel cost ${stamp}`;
  let originalTarget: number | null = null;
  let targetChanged = false;
  let costAdded = false;

  // The AE signs in once first, so their membership is active for the assignment.
  const ae = await (await browser.newContext()).newPage();
  await signInAs(ae, AE);
  await signInAs(page, LEADER);

  try {
    // 1. The target.
    await page.goto('/t/taazaa/costs');
    await expect(page.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
    originalTarget = (await api<{ target_cost_per_won_cents: number | null }>(page, 'GET', '/costs/summary')).json.target_cost_per_won_cents;
    targetChanged = true;
    await page.getByRole('button', { name: 'Set target' }).click();
    await page.getByLabel('Target cost per won account').fill('2000');
    await page.getByRole('button', { name: 'Save target' }).click();
    await shows(page, 'Target saved.');
    await expect(page.getByRole('list', { name: 'Cost totals' }).getByRole('listitem').filter({ hasText: 'Cost per won account' })).toContainText('Target $2,000');

    // 2. A new top-level source, and two accounts sent with its key.
    const added = await api<{ id: string; api_key: { secret: string } }>(page, 'POST', '/sources', { kind: 'partner', name: source, create_key: true });
    expect(added.status).toBe(201);
    const sourceId = added.json.id;
    for (const name of accounts) {
      const status = await page.evaluate(
        async ({ name, domain, secret }) => {
          const res = await fetch('/api/v1/arrivals', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'idempotency-key': crypto.randomUUID() },
            body: JSON.stringify({ account: { name, domain } }),
          });
          return res.status;
        },
        { name, domain: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.com`, secret: added.json.api_key.secret },
      );
      expect(status).toBe(202);
    }
    await expect
      .poll(
        async () => {
          const q = await api<{ data?: { name: string }[] }>(page, 'GET', '/review-queue?limit=200');
          return accounts.every((n) => (q.json.data ?? []).some((a) => a.name === n));
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    // 3. Approve and assign one of them.
    await page.goto('/t/taazaa/queue');
    await page.getByRole('button', { name: accounts[0]!, exact: true }).click();
    await page.getByRole('dialog', { name: accounts[0]! }).getByRole('button', { name: 'Approve and assign' }).click();
    const assign = page.getByRole('dialog', { name: `Assign ${accounts[0]}` });
    await assign.getByRole('radio', { name: /^Ash/ }).check();
    const go = assign.getByRole('button', { name: /^Assign to / });
    await expect(go).toBeEnabled();
    await go.click();
    await shows(page, `Sending ${accounts[0]} to HubSpot.`);

    // 4. A $500 Lists and events cost for the source.
    await page.goto('/t/taazaa/costs');
    await page.getByRole('button', { name: 'Add cost' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add cost' });
    await dialog.getByLabel('Category').selectOption('lists_events');
    await dialog.getByLabel('Amount').fill('500');
    await dialog.getByLabel('Source').selectOption({ label: source });
    await dialog.getByLabel('Note').fill(note);
    await dialog.getByRole('button', { name: 'Add cost' }).click();
    await shows(page, 'Cost added.');
    costAdded = true;
    await expect(page.getByRole('row').filter({ hasText: note })).toContainText(source);

    // 5. Funnel: Sent 2 and Spend $500 (the journeys are built by the worker, so reload until they show).
    await expect(async () => {
      await page.goto('/t/taazaa/funnel');
      const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: source }) });
      await expect(row.getByRole('cell').nth(1)).toContainText(/^2/, { timeout: 2_000 });
      await expect(row).toContainText('$500');
    }).toPass({ timeout: 60_000 });

    // The drill: Sent 2 and too early to judge.
    await page.getByRole('link', { name: source }).click();
    await page.waitForURL(new RegExp(`/funnel/${sourceId}`));
    await expect(page.getByText('Too early to judge.')).toBeVisible();
    await expect(page.getByText('Sent', { exact: true }).locator('xpath=ancestor::li[1]')).toContainText('2');

    // 6. Costs: the source in "Cost by source" with $500.
    await page.goto('/t/taazaa/costs');
    const bySource = page.getByRole('region', { name: 'Cost by source' });
    await expect(bySource.getByRole('row').filter({ has: page.getByRole('link', { name: source }) })).toContainText('$500');
    await expect(bySource.getByRole('row').filter({ hasText: 'Shared costs' })).toBeVisible();

    // 7. The source page's See in funnel opens the drill.
    await page.goto('/t/taazaa/sources');
    await page.getByRole('link', { name: source }).click();
    await page.getByRole('link', { name: 'See in funnel' }).click();
    await page.waitForURL(new RegExp(`/funnel/${sourceId}`));
    await expect(page.getByText('Too early to judge.')).toBeVisible();
  } finally {
    // Void the cost line and put the target back.
    if (costAdded) {
      await page.goto('/t/taazaa/costs');
      const row = page.getByRole('row').filter({ hasText: note }).first();
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: 'Void' }).click();
      await page.getByLabel('Reason').fill('E2E cleanup');
      await page.getByRole('button', { name: 'Void cost' }).click();
      await shows(page, 'Cost voided.');
    }
    if (targetChanged) await api(page, 'PUT', '/costs/target', { target_cost_per_won_cents: originalTarget });
    await ae.context().close();
  }
});

