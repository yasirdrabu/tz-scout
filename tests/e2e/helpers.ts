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
