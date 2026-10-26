import { expect, test, type Page } from '@playwright/test';

async function signInAs(page: Page, email: string) {
  await page.goto('/signin');
  await page.getByRole('button', { name: `Sign in as ${email}` }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'));
}

test('owner sees home, adds a member and reads their access', async ({ page }) => {
  await signInAs(page, 'zach.wiant@taazaa.com');
  await expect(page).toHaveURL(/\/t\/taazaa$/);
  await expect(page.getByText('Accounts arrive here in the next release.')).toBeVisible();

  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByTestId('member-ash@taazaa.com').getByText('Invited')).toBeVisible();

  await page.getByLabel('Email').fill('new.seller@taazaa.com');
  await page.getByLabel('Role').last().selectOption('seller');
  await page.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByTestId('member-new.seller@taazaa.com').getByText('Invited')).toBeVisible();

  await page.getByRole('link', { name: 'Profile' }).click();
  await expect(page.getByText('You can see every account in this workspace.')).toBeVisible();
});

test('seller is told they do not have access to members', async ({ page }) => {
  await signInAs(page, 'ash@taazaa.com');
  await expect(page).toHaveURL(/\/t\/taazaa$/);
  await expect(page.getByRole('link', { name: 'Members' })).toHaveCount(0);
  await page.goto('/t/taazaa/settings/members');
  await expect(page.getByText("You don't have access to that.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add member' })).toHaveCount(0);
});

test('platform admin lands on workspaces and can switch with support access', async ({ page }) => {
  await signInAs(page, 'yasir@taazaa.com');
  await expect(page).toHaveURL(/\/admin\/tenants$/);
  await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Northwind' }).click();
  await expect(page.getByText('Support access').first()).toBeVisible();
});

test('health endpoints answer', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(await res.json()).toEqual({ ok: true });
});
