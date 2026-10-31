import { expect, test } from '@playwright/test';
import { mainNav, signInAs } from './helpers';

test('sign-in lists the developer users and lands the owner in their workspace', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/signin/);
  await expect(page.getByRole('heading', { name: 'Sign in to Scout' })).toBeVisible();
  await expect(page.getByText(/^Developer sign-in is on\./)).toBeVisible();

  await signInAs(page, 'zach.wiant@taazaa.com');
  await expect(page).toHaveURL(/\/t\/taazaa\/queue$/);
  const nav = mainNav(page);
  await expect(nav.getByRole('link', { name: /^Review queue/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'All accounts' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Tenants' })).toHaveCount(0);
});

test('a seller sees only their own items and no Settings', async ({ page }) => {
  await signInAs(page, 'ash@taazaa.com');
  await expect(page).toHaveURL(/\/t\/taazaa\//);
  const nav = mainNav(page);
  await expect(nav.getByRole('link', { name: /^My accounts/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^Review queue/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Tenants' })).toHaveCount(0);

  await page.goto('/t/taazaa/settings/members');
  await expect(page.getByRole('heading', { name: "This tab isn't open to you" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite people' })).toHaveCount(0);
});

test('a platform admin with no workspace lands on Tenants with the Admin items', async ({ page }) => {
  await signInAs(page, 'yasir@taazaa.com');
  await expect(page).toHaveURL(/\/admin\/tenants$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Tenants' })).toBeVisible();
  const nav = mainNav(page);
  await expect(nav.getByRole('link', { name: 'Tenants' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'System health' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'AI runs' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'All accounts' })).toHaveCount(0);
});

test('the admin pages are closed to people who are not platform admins', async ({ page }) => {
  await signInAs(page, 'andy@taazaa.com');
  await page.goto('/admin/health');
  await expect(page.getByRole('heading', { name: 'Only platform admins can open this page' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'System health' })).toHaveCount(0);
});

test('health endpoints answer through the app', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(await res.json()).toEqual({ ok: true });
});
