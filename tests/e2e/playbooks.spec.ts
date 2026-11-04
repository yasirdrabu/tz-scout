import { expect, test, type Page } from '@playwright/test';
import { sendAccount, shows, signInAs } from './helpers';

// Playbooks (screens.md §6, §7, §19, §20): an owner builds a two-step playbook and assigns it to an offer's Good
// fit tier from the Playbooks screen; the offer page shows it with its initial message; a Good fit account of that
// offer is assigned to a seller with the playbook preselected; the seller accepts and the plan's first step is due
// today. The test makes its own offer (a unique industry, so it matches nothing else) and account, and retires the
// offer and the playbook at the end.

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

test('a playbook is built, assigned to a tier, suggested on assign, and starts when the seller accepts', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const offerName = `E2E Offer ${stamp}`;
  const playbookName = `E2E Playbook ${stamp}`;
  const accountName = `E2E Playbook Account ${stamp}`;
  const subject = `Hello from Taazaa ${stamp}`;
  let offerId = '';
  let playbookId = '';

  const seller = await (await browser.newContext()).newPage();
  await signInAs(seller, SELLER);
  await signInAs(page, OWNER);

  try {
    // An offer of our own (a unique industry matches no other account), made Active.
    const practices = await api(page, 'practices', 'GET');
    const practice = ((practices.body as { data: unknown }).data as { id: string; name: string }[])[0]!;
    const practiceId = practice.id;
    const created = await api(page, 'offers', 'POST', {
      name: offerName,
      promise: 'Prove the playbook flow end to end.',
      practice_id: practiceId,
      target_titles: ['Director of Operations'],
      industries: [`e2e-playbooks-${stamp}`],
      typical_deal_cents: 5_000_000,
      sales_cycle_days: 60,
    });
    expect(created.status).toBe(201);
    offerId = created.body!.id as string;
    expect((await api(page, `offers/${offerId}:approve`, 'POST')).status).toBe(200);

    // The owner builds a playbook with two steps: an email on day 0 and a call on day 1.
    await page.goto('/t/taazaa/playbooks?edit=new');
    const form = page.getByRole('dialog', { name: 'New playbook' });
    await form.getByLabel('Name').fill(playbookName);
    await form.getByLabel('Status').selectOption({ label: 'Active' });
    await form.getByLabel('Description').fill('Made by the playbooks end-to-end test.');
    await form.getByRole('button', { name: 'Add step' }).click();
    let step = form.getByRole('group', { name: 'Step 1' });
    await step.getByLabel('Day').fill('0');
    await step.getByLabel('Channel').selectOption({ label: 'Email' });
    await step.getByLabel('Title').fill('Intro email');
    await step.getByLabel('Subject').fill(subject);
    await step.getByLabel('Body').fill('Hi {person.first_name}, a note for {account.name}.');
    await form.getByRole('button', { name: 'Add step' }).click();
    step = form.getByRole('group', { name: 'Step 2' });
    await step.getByLabel('Day').fill('1');
    await step.getByLabel('Channel').selectOption({ label: 'Call' });
    await step.getByLabel('Title').fill('Follow-up call');
    await form.getByRole('button', { name: 'Create playbook' }).click();
    await shows(page, `${playbookName} created.`);
    await expect(page.getByRole('heading', { level: 1, name: playbookName })).toBeVisible();
    playbookId = page.url().split('/playbooks/')[1]!.split('?')[0]!;
    await expect(page.getByText('2 steps over 1 day').first()).toBeVisible();

    // Assign it to the offer's Good fit tier from the Playbooks screen.
    await page.getByRole('link', { name: 'Assign', exact: true }).click();
    const assign = page.getByRole('dialog', { name: `Assign ${playbookName}` });
    await assign.getByLabel('Offer').selectOption({ label: `${offerName} · ${practice.name}` });
    await assign.getByRole('checkbox', { name: /^Good fit/ }).check();
    await assign.getByRole('button', { name: 'Assign', exact: true }).click();
    await shows(page, new RegExp(`^${playbookName} now runs on ${offerName}`));

    // The offer page shows it by tier, and the initial message is the first email with Copy.
    await page.goto(`/t/taazaa/offers/${practiceId}/${offerId}`);
    const tiers = page.getByRole('region', { name: 'Playbook by tier' });
    await expect(tiers.getByRole('combobox', { name: 'Good fit playbook' })).toHaveValue(playbookId);
    const message = page.getByRole('group', { name: 'Good fit initial message' });
    await expect(message.getByText(subject)).toBeVisible();
    await expect(message.getByRole('button', { name: 'Copy' })).toBeVisible();

    // A Good fit account of that offer.
    await sendAccount(page, accountName);
    const queue = await api(page, 'review-queue?limit=200', 'GET');
    const row = ((queue.body as { data: unknown }).data as { name: string; account_id?: string; id?: string }[]).find((a) => a.name === accountName)!;
    const accountId = (row.account_id ?? row.id)!;
    expect((await api(page, `accounts/${accountId}/lead-offer`, 'PUT', { offer_id: offerId })).status).toBe(200);
    await expect
      .poll(async () => (await api(page, `accounts/${accountId}/tier`, 'PUT', { tier: 'good_fit' })).status, { timeout: 60_000 })
      .toBe(200);

    // Assign it to the seller. The dialog preselects the playbook.
    await page.goto('/t/taazaa/queue');
    await page.getByRole('button', { name: accountName, exact: true }).click();
    await page.getByRole('dialog', { name: accountName }).getByRole('button', { name: 'Approve and assign' }).click();
    const dialog = page.getByRole('dialog', { name: `Assign ${accountName}` });
    await dialog.getByRole('radio', { name: /^Ash/ }).check();
    await expect(dialog.getByRole('radio', { name: new RegExp(playbookName) })).toBeChecked();
    await expect(dialog.getByText('Recommended for this account')).toBeVisible();
    await expect(dialog.getByText(new RegExp(`and starts ${playbookName} when Ash accepts`))).toBeVisible();
    await dialog.getByRole('button', { name: /^Assign to / }).click();
    await shows(page, `Sending ${accountName} to HubSpot.`);

    // The seller sees the playbook on the new assignment, accepts, and the first step is due today.
    await seller.goto('/t/taazaa/my');
    const fresh = seller.getByRole('region', { name: 'New assignments' });
    await expect(fresh.getByRole('link', { name: accountName })).toBeVisible();
    await expect(fresh.getByText(new RegExp(`${playbookName} playbook`))).toBeVisible();
    await fresh.getByRole('button', { name: `Accept ${accountName}` }).click();
    await shows(seller, `Accepted. ${playbookName} starts today.`);
    const active = seller.getByRole('region', { name: 'Active' });
    await expect(async () => {
      await seller.reload();
      const activeRow = active.getByRole('row').filter({ has: seller.getByRole('link', { name: accountName }) });
      await expect(activeRow).toContainText('Intro email');
      await expect(activeRow).toContainText('Due today');
    }).toPass({ timeout: 60_000 });
  } finally {
    // Leave the playbook and the offer retired so later specs see the seeded data.
    if (playbookId) await api(page, `playbooks/${playbookId}:archive`, 'POST');
    if (offerId) await api(page, `offers/${offerId}:archive`, 'POST');
  }
});
