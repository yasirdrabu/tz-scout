import { expect, test } from '@playwright/test';
import { shows, signInAs } from './helpers';

// One owner works through Settings in order; the last test reads what the others wrote in the audit log.
test.describe.configure({ mode: 'serial' });

const INVITEE = 'new.seller@taazaa.com';
const KEY_NAME = 'E2E agent key';

test.beforeEach(async ({ page }) => {
  await signInAs(page, 'zach.wiant@taazaa.com');
});

test('Members: invite a seller, then change their role', async ({ page }) => {
  await page.goto('/t/taazaa/settings/members');
  await page.getByRole('button', { name: 'Invite people' }).first().click();
  const invite = page.getByRole('dialog', { name: 'Invite people' });
  await invite.getByLabel('Email addresses').fill(INVITEE);
  await invite.getByRole('radio', { name: /^Account executive/ }).check();
  await invite.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(invite.getByText(/Send them this link to sign in/)).toBeVisible();
  await invite.getByRole('button', { name: 'Done' }).click();

  const row = page.getByRole('row').filter({ hasText: INVITEE });
  await expect(row).toContainText('Invited');
  await expect(row).toContainText('Account executive');
  await row.getByRole('button').first().click();
  const drawer = page.getByRole('dialog').filter({ hasText: INVITEE });
  await drawer.getByLabel('Role').selectOption({ label: 'Sales leader' });
  await shows(page, /is now Sales leader\. It applies the next time they load a page\./);
  await expect(drawer.getByLabel('Role')).toHaveValue('leader');
});

test('Integrations: save a HubSpot credential and test it on the mock', async ({ page }) => {
  await page.goto('/t/taazaa/settings/integrations');
  await page.getByRole('button', { name: /^(Connect|Manage) HubSpot$/ }).click();
  const panel = page.getByRole('dialog', { name: 'HubSpot' });
  const replace = panel.getByRole('button', { name: /^Replace the / });
  if ((await replace.count()) > 0) await replace.first().click();
  await panel.getByLabel(/^Paste the /).fill('e2e-credential-value-1234');
  await panel.getByRole('button', { name: 'Save and test' }).click();
  await expect(panel.getByText('Saved. Ends in 1234.')).toBeVisible();

  const tested = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/v1/integrations/hubspot:test'));
  await panel.getByRole('button', { name: 'Test connection' }).click();
  expect((await tested).status()).toBe(200);
  await expect(panel.getByRole('region', { name: 'Connection test' }).locator('p').first()).not.toBeEmpty();
});

test('API keys: the key shows once, works, and stops working once revoked', async ({ page, request }) => {
  await page.goto('/t/taazaa/settings/api-keys');
  await page.getByRole('button', { name: 'Create a key' }).first().click();
  const create = page.getByRole('dialog', { name: 'Create an API key' });
  await create.getByLabel('Name').fill(KEY_NAME);
  await create.getByLabel('Source').selectOption({ index: 1 });
  await create.getByRole('button', { name: 'Create key' }).click();

  const created = page.getByRole('dialog', { name: `Key created for ${KEY_NAME}` });
  await expect(created.getByText("Copy this now. You won't see it again.")).toBeVisible();
  const secret = (await created.getByLabel('New API key').textContent())!.trim();
  expect(secret.length).toBeGreaterThan(20);
  const me = () => request.get('/v1/me', { headers: { authorization: `Bearer ${secret}` } });
  expect((await me()).status()).toBe(200);

  await created.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(secret)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: `Revoke ${KEY_NAME}` })).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);

  await page.getByRole('button', { name: `Revoke ${KEY_NAME}` }).click();
  await page.getByRole('dialog', { name: `Revoke ${KEY_NAME}?` }).getByRole('button', { name: 'Revoke' }).click();
  await shows(page, `${KEY_NAME} revoked. Calls with it now fail.`);
  await expect(page.getByRole('button', { name: `Revoke ${KEY_NAME}` })).toHaveCount(0);
  expect((await me()).status()).toBe(401);
});

test('Audit log: shows the invite, role change, credential and key entries, and filters by search', async ({ page }) => {
  await page.goto('/t/taazaa/settings/audit-log');
  for (const action of [
    'tenancy.member.added',
    'tenancy.member.changed',
    'integrations.credential.saved',
    'tenancy.api_key.created',
    'tenancy.api_key.revoked',
  ]) {
    await expect(page.getByRole('row').filter({ hasText: action }).first()).toContainText('zach.wiant');
  }

  await page.getByRole('searchbox', { name: 'Find an action, person or target' }).fill('api_key');
  await expect(page).toHaveURL(/[?&]q=api_key/);
  await expect(page.getByRole('row').filter({ hasText: 'tenancy.api_key.revoked' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'integrations.credential.saved' })).toHaveCount(0);
});
