import { expect, test, type Page } from '@playwright/test';
import { sendAccount, shows, signInAs } from './helpers';

// The account page (screens.md §4, Main flow 1): a leader opens an account from the queue, edits a
// brief section, approves and assigns it, and watches it reach HubSpot; the AE opens the new
// assignment from My accounts and reads the review record. Each test sends its own account.

const LEADER = 'zach.wiant@taazaa.com';
const AE = 'ash@taazaa.com';

const accountIdOf = (page: Page) => new URL(page.url()).pathname.split('/').pop()!;

/** Leader: queue, the row's peek, `Open full page`. */
async function openFromQueue(page: Page, name: string) {
  await page.goto('/t/taazaa/queue');
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog', { name }).getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

/** Leader: `Approve and assign` on the page, pick Ash, assign. */
async function assignFromPage(page: Page, name: string) {
  await page.getByRole('button', { name: 'Approve and assign' }).click();
  const dialog = page.getByRole('dialog', { name: `Assign ${name}` });
  await dialog.getByRole('radio', { name: /^ash/i }).check();
  const go = dialog.getByRole('button', { name: /^Assign to / });
  await expect(go).toBeEnabled();
  await go.click();
  await shows(page, `Sending ${name} to HubSpot.`);
}

test('a leader opens an account from the queue, edits a brief section, approves and assigns', async ({ page, browser }) => {
  // The AE signs in once first, so their membership is active and they can be assigned.
  await signInAs(await (await browser.newContext()).newPage(), AE);
  await signInAs(page, LEADER);
  const name = 'E2E Account Page';
  await sendAccount(page, name);
  await openFromQueue(page, name);
  expect(new URL(page.url()).searchParams.get('from')).toBe('queue');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Review queue' })).toBeVisible();

  // The brief is drafted from rules (or the mock) when the account is scored.
  const brief = page.getByRole('region', { name: 'Brief' });
  const overview = brief.getByRole('region', { name: 'Overview' });
  await expect(overview.getByText(/^(Assembled from rules|Sample output)$/)).toBeVisible({ timeout: 60_000 });

  await overview.getByRole('button', { name: 'Edit Overview' }).click();
  const line = `Zach met their CIO at a conference ${Date.now()}.`;
  await overview.getByRole('textbox', { name: 'Overview' }).fill(line);
  await overview.getByRole('button', { name: 'Save' }).click();
  await shows(page, 'Overview saved');
  await expect(overview.getByText(/^Edited by Zach/i)).toBeVisible();

  await page.reload();
  await expect(overview.getByText(line)).toBeVisible();
  await expect(overview.getByText(/^Edited by Zach/i)).toBeVisible();

  await assignFromPage(page, name);
  await expect(page.getByRole('region', { name: 'Assignment' })).toContainText(/Waiting for Ash.* to accept/i);
  // The page polls while the send runs.
  await expect(page.getByText(/^In HubSpot/).first()).toBeVisible({ timeout: 60_000 });

  const id = accountIdOf(page);
  const handoffs = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/accounts/${id}/handoffs`, { credentials: 'include', headers: { 'x-scout-tenant': 'taazaa' } });
    return (await res.json()) as { handoffs: { status: string }[] };
  }, id);
  expect(handoffs.handoffs[0]?.status).toBe('completed');
});

test('an AE opens a new assignment from My accounts and sees the review record', async ({ page, browser }) => {
  const ae = await (await browser.newContext()).newPage();
  await signInAs(ae, AE);
  await signInAs(page, LEADER);
  const name = 'E2E Account Record';
  await sendAccount(page, name);
  await openFromQueue(page, name);
  await assignFromPage(page, name);

  await ae.goto('/t/taazaa/my');
  await ae.getByRole('region', { name: 'New assignments' }).getByRole('link', { name }).click();
  await expect(ae.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(ae.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'My accounts' })).toBeVisible();
  const record = ae.getByRole('region', { name: 'Review record' });
  await expect(record).toContainText('Approved by');
  await record.getByRole('button', { name: 'Show the full brief, signals and facts' }).click();
  await expect(record.getByRole('region', { name: 'Why now' })).toBeVisible();
  await expect(record.getByRole('region', { name: 'Brief' })).toBeVisible();
});
