import { expect, test, type Page } from '@playwright/test';
import { sendAccount, shows, signInAs } from './helpers';

// Account plan (screens.md §4b item 2): a seller accepts an assignment that starts a two-step playbook, opens the
// account page, sees "Day 1 of 2" and the first step due today, ticks it, adds a step through Edit plan, then pauses
// and resumes the plan. The test makes its own offer (a unique industry, so it matches nothing else), playbook and
// account, and retires the offer and the playbook at the end.

const OWNER = 'zach.wiant@taazaa.com';
const SELLER = 'ash@taazaa.com';

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

test('a seller runs the plan on the account page: tick a step, add one, pause and resume', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const offerName = `E2E Plan Offer ${stamp}`;
  const playbookName = `E2E Plan Playbook ${stamp}`;
  const accountName = `E2E Plan Account ${stamp}`;
  let offerId = '';
  let playbookId = '';

  const seller = await (await browser.newContext()).newPage();
  await signInAs(seller, SELLER);
  await signInAs(page, OWNER);

  try {
    // An offer of our own and an active two-step playbook on its Good fit tier, made through the API.
    const practices = await api(page, 'practices', 'GET');
    const practiceId = ((practices.body as { data: unknown }).data as { id: string }[])[0]!.id;
    const offer = await api(page, 'offers', 'POST', {
      name: offerName,
      promise: 'Prove the account plan flow end to end.',
      practice_id: practiceId,
      target_titles: ['Director of Operations'],
      industries: [`e2e-plan-${stamp}`],
      typical_deal_cents: 5_000_000,
      sales_cycle_days: 60,
    });
    expect(offer.status).toBe(201);
    offerId = offer.body!.id as string;
    expect((await api(page, `offers/${offerId}:approve`, 'POST')).status).toBe(200);
    const playbook = await api(page, 'playbooks', 'POST', {
      name: playbookName,
      status: 'active',
      steps: [
        { day: 0, channel: 'email', owner_role: 'seller', title: 'Intro email', subject: `Hello ${stamp}`, body: 'Hi {person.first_name}.' },
        { day: 1, channel: 'call', owner_role: 'seller', title: 'Follow-up call' },
      ],
    });
    expect(playbook.status).toBe(201);
    playbookId = playbook.body!.id as string;
    expect((await api(page, `offers/${offerId}/playbooks/good_fit`, 'PUT', { playbook_id: playbookId })).status).toBe(200);

    // A Good fit account of that offer, assigned to the seller, who accepts.
    await sendAccount(page, accountName);
    const queue = await api(page, 'review-queue?limit=200', 'GET');
    const row = ((queue.body as { data: unknown }).data as { name: string; account_id?: string; id?: string }[]).find((a) => a.name === accountName)!;
    const accountId = (row.account_id ?? row.id)!;
    expect((await api(page, `accounts/${accountId}/lead-offer`, 'PUT', { offer_id: offerId })).status).toBe(200);
    await expect
      .poll(async () => (await api(page, `accounts/${accountId}/tier`, 'PUT', { tier: 'good_fit' })).status, { timeout: 60_000 })
      .toBe(200);
    await page.goto('/t/taazaa/queue');
    await page.getByRole('button', { name: accountName, exact: true }).click();
    await page.getByRole('dialog', { name: accountName }).getByRole('button', { name: 'Approve and assign' }).click();
    const dialog = page.getByRole('dialog', { name: `Assign ${accountName}` });
    await dialog.getByRole('radio', { name: /^Ash/ }).check();
    await expect(dialog.getByRole('radio', { name: new RegExp(playbookName) })).toBeChecked();
    await dialog.getByRole('button', { name: /^Assign to / }).click();
    await shows(page, `Sending ${accountName} to HubSpot.`);

    await seller.goto('/t/taazaa/my');
    await seller.getByRole('region', { name: 'New assignments' }).getByRole('button', { name: `Accept ${accountName}` }).click();
    await shows(seller, `Accepted. ${playbookName} starts today.`);

    // The account page: Day 1 of 2, and the first step is due today (a weekend start moves it to Monday).
    const active = seller.getByRole('region', { name: 'Active' });
    await expect(async () => {
      await seller.reload();
      await expect(active.getByRole('link', { name: accountName })).toBeVisible();
    }).toPass({ timeout: 60_000 });
    await active.getByRole('link', { name: accountName }).click();
    await expect(seller.getByText(`${playbookName} · Day 1 of 2`)).toBeVisible();
    await expect(seller.getByText('0 of 2 done')).toBeVisible();
    const first = seller.getByRole('listitem').filter({ has: seller.getByRole('button', { name: 'Intro email' }) });
    const weekend = [0, 6].includes(new Date().getDay());
    await expect(first).toContainText(weekend ? 'Not started' : /Due [A-Z][a-z]{2} \d{1,2}/);

    // Tick it.
    await first.getByRole('checkbox', { name: 'Mark Intro email done' }).click();
    await shows(seller, 'Step updated.');
    await expect(seller.getByText('1 of 2 done')).toBeVisible();
    await expect(first).toContainText('Done');

    // Add a step through Edit plan.
    await seller.getByRole('button', { name: 'Edit plan' }).click();
    const drawer = seller.getByRole('dialog', { name: 'Edit plan' });
    const add = drawer.getByRole('form', { name: 'Add step' });
    await add.getByLabel('Day').fill('3');
    await add.getByLabel('Title').fill('Extra check-in');
    await add.getByRole('button', { name: 'Add step' }).click();
    await shows(seller, 'Step added.');
    await expect(drawer.getByText('Extra check-in')).toBeVisible();
    await seller.keyboard.press('Escape');
    await expect(seller.getByRole('button', { name: 'Extra check-in' })).toBeVisible();
    await expect(seller.getByText('1 of 3 done')).toBeVisible();

    // Pause, then resume.
    await seller.getByRole('button', { name: 'Plan actions' }).click();
    await seller.getByRole('menuitem', { name: 'Pause' }).click();
    await shows(seller, 'Plan paused.');
    await seller.getByRole('button', { name: 'Plan actions' }).click();
    await seller.getByRole('menuitem', { name: 'Resume' }).click();
    await shows(seller, 'Plan resumed.');
    await seller.getByRole('button', { name: 'Plan actions' }).click();
    await expect(seller.getByRole('menuitem', { name: 'Pause' })).toBeVisible();
  } finally {
    // Leave the playbook and the offer retired so later specs see the seeded data.
    if (playbookId) await api(page, `playbooks/${playbookId}:archive`, 'POST');
    if (offerId) await api(page, `offers/${offerId}:archive`, 'POST');
  }
});
