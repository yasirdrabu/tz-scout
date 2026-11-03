import { expect, test } from '@playwright/test';
import { shows, signInAs } from './helpers';

// Usage caps (usage-caps.md INT-E4-S1, INT-E4-S3; screens.md §21b): the owner sees HubSpot's daily
// limit, a limit reached stops the next call and shows a banner, and Allow until lifts the stop.

const OWNER = 'zach.wiant@taazaa.com';

// Puts HubSpot's limit back through the API with the page's session, so a failed step never leaves it at 1.
test.afterEach(async ({ page, baseURL }) => {
  const res = await page.request.put('/api/v1/integrations/hubspot/cap', {
    data: { limit: 50000 },
    headers: { 'x-scout-tenant': 'taazaa', origin: baseURL!, 'idempotency-key': crypto.randomUUID() },
  });
  expect(res.status()).toBe(200);
});

test('a service reaching its limit shows a banner, and the owner can allow going over', async ({ page }) => {
  await signInAs(page, OWNER);
  await page.goto('/t/taazaa/settings/integrations');
  await page.getByRole('button', { name: /^(Connect|Manage) HubSpot$/ }).click();
  const panel = page.getByRole('dialog', { name: 'HubSpot' });

  // Test connection needs a saved credential; the mock accepts any value.
  const replace = panel.getByRole('button', { name: /^Replace the / });
  if ((await replace.count()) > 0) await replace.first().click();
  await panel.getByLabel(/^Paste the /).fill('e2e-credential-value-1234');
  await panel.getByRole('button', { name: 'Save and test' }).click();
  await expect(panel.getByText('Saved. Ends in 1234.')).toBeVisible();

  const usage = panel.getByRole('region', { name: 'Usage limit' });
  await expect(usage.getByText(/^[\d,]+ of 50,000 calls today\. Resets [A-Z][a-z]{2} \d{1,2}\.$/)).toBeVisible();

  await usage.getByLabel('Limit per day').fill('1');
  await usage.getByRole('button', { name: 'Save limit' }).click();
  await shows(page, 'Limit saved.');
  await expect(usage.getByText(/ of 1 calls today\. Resets /)).toBeVisible();

  // The credential save and test already used the one call, so this one is refused.
  await panel.getByRole('button', { name: 'Test connection' }).click();
  await shows(page, /^HubSpot reached its daily limit\. Scout stopped calling it until [A-Z][a-z]{2} \d{1,2}\.$/);

  await usage.getByRole('button', { name: /^Allow until / }).click();
  await shows(page, /^HubSpot can go over its limit until [A-Z][a-z]{2} \d{1,2}\.$/);
  await shows(page, /^HubSpot is allowed over its limit until [A-Z][a-z]{2} \d{1,2}\.$/);
  await expect(page.getByText(/Scout stopped calling it until/)).toHaveCount(0);

  await usage.getByLabel('Limit per day').fill('50000');
  await usage.getByRole('button', { name: 'Save limit' }).click();
  await shows(page, 'Limit saved.');
  await expect(usage.getByText(/ of 50,000 calls today\. Resets /)).toBeVisible();
});
