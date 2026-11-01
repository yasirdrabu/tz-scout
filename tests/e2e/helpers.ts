import { expect, type Page } from '@playwright/test';

/** Developer sign-in on the app's sign-in page, as the seeded person with this email. */
export async function signInAs(page: Page, email: string) {
  await page.goto('/signin');
  await page.getByRole('button').filter({ hasText: email }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'));
}

/** The app's sidebar. */
export const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** Waits for a toast or line of text to show. */
export const shows = (page: Page, text: string | RegExp) => expect(page.getByText(text).first()).toBeVisible();

/** Sends an account as the signed-in person and waits until the worker has put it in the queue. */
export async function sendAccount(page: Page, name: string) {
  const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.com`;
  const status = await page.evaluate(
    async ({ name, domain }) => {
      const res = await fetch('/api/v1/arrivals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-scout-tenant': 'taazaa', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ account: { name, domain } }),
      });
      return res.status;
    },
    { name, domain },
  );
  expect(status).toBe(202);
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
}
