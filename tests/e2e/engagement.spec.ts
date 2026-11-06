import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { e2eEnv } from './env';
import { sendAccount, signInAs } from './helpers';

// Meetings and engagement (R2d, screens.md §4b items 1, 3 and 5): an account is handed off to HubSpot (the mock) and
// has five people. The mock then holds a meeting with two of them, has a meeting still to come (with one of those
// two and a fifth) and a reply from a third. After Check follow-through the Meetings held and Buyers engaged tiles,
// the activity rows and the committee's dots and labels say so. The mock activity comes from the `mock-activity` mode of prepare-db.ts.

const LEADER = 'zach.wiant@taazaa.com';
const AE = 'ash@taazaa.com';

const api = (page: Page, path: string, method: string, body?: unknown) =>
  page.evaluate(
    async ({ path, method, body }) => {
      const res = await fetch(`/api/v1/${path}`, {
        method,
        credentials: 'include',
        headers: { 'x-scout-tenant': 'taazaa', ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'idempotency-key': crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    },
    { path, method, body },
  );

test('the tiles, the feed and the committee show the meetings and replies HubSpot recorded', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const name = `E2E Engagement ${stamp}`;
  // The AE signs in once in a browser of their own; that page is not used again.
  const aeContext = await browser.newContext();
  await signInAs(await aeContext.newPage(), AE);
  await aeContext.close();
  await signInAs(page, LEADER);
  await sendAccount(page, name);

  // Approve and assign to Ash; the page shows "In HubSpot" once the mock has the company.
  await page.goto('/t/taazaa/queue');
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('dialog', { name }).getByRole('link', { name: 'Open full page' }).click();
  // Scoring drafts the brief first; assigning waits for it.
  await expect(page.getByRole('region', { name: 'Brief' }).getByText(/^(Assembled from rules|Sample output)$/).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Approve and assign' }).click();
  const dialog = page.getByRole('dialog', { name: `Assign ${name}` });
  await dialog.getByRole('radio', { name: /^Ash/ }).check();
  const go = dialog.getByRole('button', { name: /^Assign to / });
  await expect(go).toBeEnabled();
  await go.click();
  await expect(page.getByText(/^In HubSpot/).first()).toBeVisible({ timeout: 60_000 });
  const id = new URL(page.url()).pathname.split('/').pop()!;

  // Five people; the worker pushes each to the mock as a contact.
  const added: string[] = [];
  for (const [first, last] of [
    ['Mia', 'Held'],
    ['Ben', 'Held'],
    ['Rae', 'Replied'],
    ['Nia', 'Quiet'],
    ['Sol', 'Booked'],
  ]) {
    const res = await api(page, `accounts/${id}/people`, 'POST', { name: `${first} ${last}`, email: `${first}.${last}.${stamp}@e2e-engagement.example`.toLowerCase() });
    expect(res.status).toBe(201);
    added.push(res.body!.person_id as string);
  }
  // The helper pushes any of Mia, Ben, Rae and Sol the worker has not linked yet, then adds the activity.
  await expect(async () => {
    execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/prepare-db.ts', 'mock-activity', id, ...added.slice(0, 3), added[4]!], { stdio: 'pipe', env: { ...process.env, ...e2eEnv } });
  }).toPass({ timeout: 60_000 });

  expect((await api(page, `accounts/${id}:check-follow-through`, 'POST')).status).toBe(202);
  await expect
    .poll(async () => ((await api(page, `accounts/${id}/engagement`, 'GET')).body as { engaged?: number } | null)?.engaged, { timeout: 60_000 })
    .toBe(3);

  await page.goto(`/t/taazaa/accounts/${id}`);
  const outcomes = page.getByRole('region', { name: 'Outcomes' });
  await expect(outcomes.locator('div').filter({ hasText: /^Meetings held/ })).toContainText(/Meetings held1Next: [A-Z][a-z]{2} \d{1,2} with Roadmap review/);
  await expect(outcomes.locator('div').filter({ hasText: /^Buyers engaged/ })).toContainText('3 of 5');

  const activity = page.getByRole('region', { name: 'HubSpot activity' });
  await expect(activity.getByRole('listitem').filter({ hasText: 'Meeting held with Mia Held and Ben Held, 30 minutes' })).toBeVisible();
  await expect(activity.getByRole('listitem').filter({ hasText: 'Replied: "Re: Hello from Taazaa"' })).toContainText('Rae Replied');

  const rail = page.getByRole('complementary', { name: 'Account details' });
  const person = (who: string) => rail.getByRole('listitem').filter({ has: page.getByText(who, { exact: true }) });
  await expect(person('Mia Held')).toContainText(/Met [A-Z][a-z]{2} \d{1,2}/);
  await expect(person('Ben Held')).toContainText(/Met [A-Z][a-z]{2} \d{1,2}/);
  await expect(person('Rae Replied')).toContainText(/Replied [A-Z][a-z]{2} \d{1,2}/);
  await expect(person('Sol Booked')).toContainText(/Meeting set up [A-Z][a-z]{2} \d{1,2}/);
  await expect(person('Nia Quiet')).toContainText('Not contacted');
});
