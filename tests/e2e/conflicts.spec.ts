import { expect, test, type Page } from '@playwright/test';
import { shows, signInAs } from './helpers';

// Field conflicts (facts-provenance-and-conflicts.md ACC-E3-S3, S4; screens.md §2, §4a): two
// sources send different contract values for one account; the queue and the account page flag the
// conflict, and a person keeps one value.

const LEADER = 'zach.wiant@taazaa.com';

/** Sends one arrival as the signed-in person. `via_vendor` adds a vendor to the chain, so it is a different source. */
async function send(page: Page, body: unknown) {
  const status = await page.evaluate(async (body) => {
    const res = await fetch('/api/v1/arrivals', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-scout-tenant': 'taazaa', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    return res.status;
  }, body);
  expect(status).toBe(202);
}

/** The queue row for the account, reloading until the worker has put it there with the expected text. */
async function queueRow(page: Page, name: string, has: string | null) {
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(async () => {
    await page.goto('/t/taazaa/queue');
    await expect(row).toBeVisible({ timeout: 3_000 });
    if (has) await expect(row).toContainText(has, { timeout: 3_000 });
    else await expect(row).not.toContainText(/\bconflicts?\b/, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  return row;
}

test('two sources disagree on the contract value and a person keeps one', async ({ page }) => {
  await signInAs(page, LEADER);
  const name = 'E2E Conflict Settles';
  const domain = `e2e-conflict-${Date.now()}.com`;
  await send(page, { account: { name, domain }, facts: { contract_value_cents: 2_090_000_000 } });
  await queueRow(page, name, null);
  await send(page, { account: { name, domain }, facts: { contract_value_cents: 1_840_000_000 }, via_vendor: 'apollo' });
  await queueRow(page, name, '1 conflict');

  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog', { name }).getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await shows(page, '1 conflict to resolve');
  await shows(page, 'Sources disagree');

  await page.getByRole('button', { name: /^Keep \$18,400,000 from / }).click();
  await shows(page, /^Kept \$18,400,000 from .+\. Scout will use it in the brief and HubSpot\.$/);

  await page.reload();
  await shows(page, 'All facts agree');
  await queueRow(page, name, null);
});
