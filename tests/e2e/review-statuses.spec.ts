import { expect, test, type Page } from '@playwright/test';
import { sendAccount, shows, signInAs } from './helpers';

// An owner edits a review status and a send-back reason in Settings > Review statuses (§21d), and the
// review queue's filter, the peek's status and the Send-back dialog show them. The defaults are
// restored at the end through the page's fetch, so later specs see the seeded words.

const OWNER = 'zach.wiant@taazaa.com';

const restoreDefaults = (page: Page) =>
  page.evaluate(async () => {
    const res = await fetch('/api/v1/settings/review:reset', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-scout-tenant': 'taazaa', 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: '{}',
    });
    return res.status;
  });

test.afterAll(async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await signInAs(page, OWNER);
  expect(await restoreDefaults(page)).toBe(200);
});

test('an owner edits a review status and a send-back reason and the queue shows it', async ({ page }) => {
  await signInAs(page, OWNER);
  const ts = Date.now();
  const status = `Being checked ${ts}`;
  const reason = `Wrong region ${ts}`;
  const name = `E2E Statuses ${ts}`;
  await sendAccount(page, name);

  await page.goto('/t/taazaa/settings/review-statuses');
  const inReview = page.getByRole('textbox', { name: 'Name of In review' });
  await inReview.fill(status);
  const sendBack = page.getByRole('region', { name: 'Send-back reasons' });
  await sendBack.getByRole('textbox', { name: 'Add a reason to Send-back reasons' }).fill(reason);
  await sendBack.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sendBack.getByRole('switch', { name: 'Note required for the new reason' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Save statuses' }).click();
  await shows(page, 'Review statuses saved. The review queue now shows them.');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Review queue/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Review queue' })).toBeVisible();
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('tab', { name: /^Review status/ }).click();
  await expect(page.getByRole('tabpanel').getByText(status, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name, exact: true }).click();
  const peek = page.getByRole('dialog', { name });
  // A person's own account starts in the renamed status, so move it out first, then back to it.
  await peek.getByLabel('Review status').selectOption({ label: 'Ready for review' });
  await shows(page, 'Review status changed to Ready for review.');
  await peek.getByLabel('Review status').selectOption({ label: status });
  await shows(page, `Review status changed to ${status}.`);
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
  // The peek is modal: close it to read the row, then open it again.
  await page.keyboard.press('Escape');
  await expect(row).toContainText(status);

  await page.getByRole('button', { name, exact: true }).click();
  await peek.getByRole('button', { name: 'Send back' }).click();
  const dialog = page.getByRole('dialog', { name: /^Send back to / });
  await dialog.getByText(reason, { exact: true }).click();
  const go = dialog.getByRole('button', { name: /^Send back/ });
  await expect(go).toBeEnabled();
  await go.click();
  await shows(page, new RegExp(`^Sent back to .+\\. ${name} left the queue\\.$`));
});
