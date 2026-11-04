import { expect, test } from '@playwright/test';
import { shows, signInAs } from './helpers';

// Buying committee (buying-committee.md ACC-E2-S1, S2, S3; screens.md §4a): the rail shows coverage against the
// required roles, Find opens Enrich with the gap's role picked, the person Enrich finds is a guess until someone
// confirms it. The test sends its own account (one stated business owner) and leaves every limit alone.

const OWNER = 'zach.wiant@taazaa.com';

test('Find fills a committee gap with a guess, and Confirm counts it', async ({ page }) => {
  await signInAs(page, OWNER);
  const name = `E2E Committee ${Date.now()}`;
  const domain = `e2e-committee-${Date.now()}.com`;
  const status = await page.evaluate(
    async ({ name, domain }) => {
      const res = await fetch('/api/v1/arrivals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-scout-tenant': 'taazaa', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ account: { name, domain }, people: [{ name: 'Olivia Owner', title: 'Director of Operations', buying_role: 'business_owner', email: 'olivia@example.com' }] }),
      });
      return res.status;
    },
    { name, domain },
  );
  expect(status).toBe(202);

  // Wait until the worker has put it in the queue, then open its page from there.
  await expect
    .poll(
      () =>
        page.evaluate(async (name) => {
          const res = await fetch('/api/v1/review-queue?limit=200', { credentials: 'include', headers: { 'x-scout-tenant': 'taazaa' } });
          const body = (await res.json()) as { data?: { name: string }[] };
          return (body.data ?? []).some((a) => a.name === name);
        }, name),
      { timeout: 60_000 },
    )
    .toBe(true);
  await page.goto('/t/taazaa/queue');
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog', { name }).getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const committee = page.getByRole('region', { name: 'Buying committee' });
  await expect(committee.getByText(/1 of 3 roles covered$/)).toBeVisible();
  await expect(committee.getByText('No commercial buyer yet')).toBeVisible();
  await expect(committee.getByText('No technical buyer yet')).toBeVisible();

  // Find on Technical buyer opens Enrich with that role alone picked.
  await committee.getByRole('button', { name: 'Find technical buyer' }).click();
  const dialog = page.getByRole('dialog', { name: `Enrich ${name}` });
  const roles = dialog.getByRole('group', { name: 'Buying roles' });
  await expect(roles.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(roles.getByRole('checkbox', { name: 'Technical buyer' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Run enrichment' }).click();
  await shows(page, `Enrichment started for ${name}.`);

  // The run finishes in the worker; the committee refreshes with no reload. The found person is a guess, so the
  // technical buyer row is no longer a gap, and the summary has not moved yet.
  await expect(committee.getByText('Guessed from title').first()).toBeVisible({ timeout: 30_000 });
  await expect(committee.getByText('No technical buyer yet')).toHaveCount(0);
  await expect(committee.getByText(/1 of 3 roles covered$/)).toBeVisible();

  // Confirm it: the summary rises by one.
  await committee.getByRole('button', { name: /^Confirm Technical buyer for / }).first().click();
  await shows(page, /^Technical buyer confirmed for /);
  await expect(committee.getByText(/2 of 3 roles covered$/)).toBeVisible();
});
