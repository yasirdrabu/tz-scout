import { expect, test, type Browser, type Page } from '@playwright/test';
import { sendAccount, shows, signInAs } from './helpers';

// The review flow (screens.md, Main flows 1 and 2): a leader assigns from the queue and the AE
// accepts; the AE declines with a reason and the account is back in the queue; a send back with a
// reason takes the account out of the queue. Each test sends its own account through the API.

const LEADER = 'zach.wiant@taazaa.com';
const AE = 'ash@taazaa.com';

/** A second person in their own browser context. The AE signs in once first, so their membership is active. */
async function aePage(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  await signInAs(page, AE);
  return page;
}

/** Leader: open the account in the queue's peek drawer and assign it to the AE. */
async function assignToAe(page: Page, name: string) {
  await page.goto('/t/taazaa/queue');
  await page.getByRole('button', { name, exact: true }).click();
  const peek = page.getByRole('dialog', { name });
  await peek.getByRole('button', { name: 'Approve and assign' }).click();
  const dialog = page.getByRole('dialog', { name: `Assign ${name}` });
  await dialog.getByRole('radio', { name: /^ash/i }).check();
  const go = dialog.getByRole('button', { name: /^Assign to / });
  await expect(go).toBeEnabled();
  await go.click();
  await shows(page, `Sending ${name} to HubSpot.`);
}

test('a leader assigns from the queue and the AE accepts in My accounts', async ({ page, browser }) => {
  const ae = await aePage(browser);
  await signInAs(page, LEADER);
  const name = 'E2E Assign Works';
  await sendAccount(page, name);
  await assignToAe(page, name);
  await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);

  await ae.goto('/t/taazaa/my');
  const fresh = ae.getByRole('region', { name: 'New assignments' });
  await expect(fresh.getByRole('link', { name })).toBeVisible();
  await fresh.getByRole('button', { name: `Accept ${name}` }).click();
  await shows(ae, `Accepted. ${name} is in your accounts.`);
  await expect(ae.getByRole('region', { name: 'Active' }).getByRole('link', { name })).toBeVisible();
});

test('the AE declines with a reason and the account is back in the leader’s queue', async ({ page, browser }) => {
  const ae = await aePage(browser);
  await signInAs(page, LEADER);
  const name = 'E2E Decline Returns';
  await sendAccount(page, name);
  await assignToAe(page, name);

  await ae.goto('/t/taazaa/my');
  await ae.getByRole('button', { name: `Decline ${name}` }).click();
  const panel = ae.getByRole('region', { name: `Decline ${name}` });
  // The reason chips are labels over visually hidden radios.
  const reason = panel.getByRole('radio').first();
  await reason.waitFor({ state: 'attached' });
  await reason.check({ force: true });
  await expect(reason).toBeChecked();
  await panel.getByRole('textbox').fill('Outside what I cover this quarter.');
  await panel.getByRole('button', { name: /^Decline and return to / }).click();
  await shows(ae, new RegExp(`^Declined\\. ${name} is back with .+, with your reason\\.$`));

  await page.goto('/t/taazaa/queue');
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
  await expect(row).toContainText('Declined by');
});

test('send back with a reason takes the account out of the queue', async ({ page }) => {
  await signInAs(page, LEADER);
  const name = 'E2E Send Back';
  await sendAccount(page, name);
  await page.goto('/t/taazaa/queue');
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog', { name }).getByRole('button', { name: 'Send back' }).click();
  const dialog = page.getByRole('dialog', { name: /^Send back to / });
  const go = dialog.getByRole('button', { name: /^Send back/ });
  await expect(go).toBeDisabled();
  await dialog.getByText('Not our kind of customer').click();
  await go.click();
  await shows(page, `${name} left the queue.`);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Review queue' })).toBeVisible();
  await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
});
