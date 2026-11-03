import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { ACCOUNT, PAGE_LEADER, SELLER, serveAccount } from '../account/testing';
import { LEADER, serveQueue } from '../review/testing';
import type { EnrichmentRequest } from './api';
import { APPROVER, REQUEST, REQUESTER, serveEnrichment } from './testing';

const URL = '/t/taazaa/accounts/acc_mdc';

async function openDialog() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Enrich' }));
  const dialog = await screen.findByRole('dialog', { name: 'Enrich Miami-Dade County DTPW' });
  return { user, dialog };
}

beforeEach(() => localStorage.clear());

describe('Enrich dialog', () => {
  it('an approver sees Run enrichment and the estimate; confirming posts and shows the started toast', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER] });
    const seen = serveEnrichment();
    renderApp(URL);
    const { user, dialog } = await openDialog();
    expect(within(dialog).getByRole('combobox', { name: 'What to find' })).toHaveDisplayValue('People for buying roles');
    expect(within(dialog).getByRole('combobox', { name: 'Provider' })).toHaveDisplayValue('Apollo');
    expect(await within(dialog).findByText('Up to 3 credits, about $0.30 · Sample')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: 'Why is this worth it?' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Run enrichment' }));
    expect(await screen.findByText('Enrichment started for Miami-Dade County DTPW. New signals appear in about 2 minutes.')).toBeInTheDocument();
    expect(seen.posted).toEqual([{ kind: 'people_for_roles', provider_key: 'apollo', roles: ['technical_buyer'] }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('buying roles default to the roles with no person yet', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER] });
    serveEnrichment();
    renderApp(URL);
    const { dialog } = await openDialog();
    const roles = within(dialog).getByRole('group', { name: 'Buying roles' });
    expect(await within(roles).findByRole('checkbox', { name: 'Technical buyer' })).toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Business owner' })).not.toBeChecked();
  });

  it('with every role covered nothing is checked, and confirming asks for a role', async () => {
    const both = [{ key: 'business_owner', origin: 'stated', label: 'Business owner' }, { key: 'technical_buyer', origin: 'stated', label: 'Technical buyer' }];
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER], account: { ...ACCOUNT, people: [{ ...ACCOUNT.people[0]!, roles: both }] } });
    const seen = serveEnrichment();
    renderApp(URL);
    const { user, dialog } = await openDialog();
    const roles = within(dialog).getByRole('group', { name: 'Buying roles' });
    expect(await within(roles).findByRole('checkbox', { name: 'Technical buyer' })).not.toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Business owner' })).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Run enrichment' }));
    expect(within(dialog).getByText('Pick at least one buying role.')).toBeInTheDocument();
    expect(seen.posted).toEqual([]);
    expect(seen.estimates).toEqual([]);
  });

  it('changing the kind or the roles refetches the estimate', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER] });
    const seen = serveEnrichment();
    renderApp(URL);
    const { user, dialog } = await openDialog();
    await within(dialog).findByText('Up to 3 credits, about $0.30 · Sample');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Business owner' }));
    expect(await within(dialog).findByText('Up to 6 credits, about $0.60 · Sample')).toBeInTheDocument();
    expect(seen.estimates.at(-1)!.searchParams.get('roles')).toBe('business_owner,technical_buyer');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'What to find' }), 'Company facts');
    expect(await within(dialog).findByText('Up to 1 credits, about $0.10 · Sample')).toBeInTheDocument();
    const last = seen.estimates.at(-1)!;
    expect(last.searchParams.get('kind')).toBe('company_firmographics');
    expect(last.searchParams.get('provider_key')).toBe('apollo');
    expect(last.searchParams.has('roles')).toBe(false);
    expect(within(dialog).queryByRole('group', { name: 'Buying roles' })).toBeNull();
  });

  it('Read the website offers only Company website', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER] });
    const seen = serveEnrichment();
    renderApp(URL);
    const { user, dialog } = await openDialog();
    const options = () => within(within(dialog).getByRole('combobox', { name: 'Provider' })).getAllByRole('option').map((o) => o.textContent);
    expect(options()).toEqual(['Apollo', 'Vibe Prospecting']);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'What to find' }), 'Read the website');
    expect(options()).toEqual(['Company website']);
    await waitFor(() => expect(seen.estimates.at(-1)!.searchParams.get('provider_key')).toBe('website'));
  });

  it('Reveal emails lists the people without an email, all checked, and sends their ids', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER], account: { ...ACCOUNT, people: [...ACCOUNT.people, { ...ACCOUNT.people[0]!, id: 'per_ap', first_name: 'Ash', last_name: 'Park', email: 'ash@miamidade.gov' }] } });
    const seen = serveEnrichment();
    renderApp(URL);
    const { user, dialog } = await openDialog();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'What to find' }), 'Reveal emails');
    const people = within(dialog).getByRole('group', { name: 'People' });
    expect(within(people).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(people).getByRole('checkbox', { name: 'Jarice Rodriguez' })).toBeChecked();
    await waitFor(() => expect(seen.estimates.at(-1)!.searchParams.get('person_ids')).toBe('per_jr'));
    await user.click(within(dialog).getByRole('button', { name: 'Run enrichment' }));
    await screen.findByText('Enrichment started for Miami-Dade County DTPW. New signals appear in about 2 minutes.');
    expect(seen.posted).toEqual([{ kind: 'email_reveal', provider_key: 'apollo', person_ids: ['per_jr'] }]);
  });

  it('Reveal emails with everyone emailed says so and cannot be confirmed', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER], account: { ...ACCOUNT, people: [{ ...ACCOUNT.people[0]!, email: 'jr@miamidade.gov' }] } });
    serveEnrichment();
    renderApp(URL);
    const { user, dialog } = await openDialog();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'What to find' }), 'Reveal emails');
    expect(within(dialog).getByText('Everyone here already has an email.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Run enrichment' })).toBeDisabled();
  });

  it('Reveal emails checks the first 25 people, and more than 25 cannot be confirmed', async () => {
    const many = Array.from({ length: 27 }, (_, i) => ({ ...ACCOUNT.people[0]!, id: `per_${i}`, first_name: 'Person', last_name: String(i + 1), email: null }));
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER], account: { ...ACCOUNT, people: many } });
    const seen = serveEnrichment();
    renderApp(URL);
    const { user, dialog } = await openDialog();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'What to find' }), 'Reveal emails');
    const people = within(dialog).getByRole('group', { name: 'People' });
    const boxes = within(people).getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([...Array(25).fill(true), false, false]);
    const run = within(dialog).getByRole('button', { name: 'Run enrichment' });
    expect(run).toBeEnabled();
    await user.click(within(people).getByRole('checkbox', { name: 'Person 26' }));
    expect(within(people).getByText('Pick up to 25 people.')).toBeInTheDocument();
    expect(run).toBeDisabled();
    await user.click(within(people).getByRole('checkbox', { name: 'Person 1' }));
    expect(within(people).queryByText('Pick up to 25 people.')).toBeNull();
    await user.click(run);
    await screen.findByText('Enrichment started for Miami-Dade County DTPW. New signals appear in about 2 minutes.');
    expect((seen.posted[0] as { person_ids: string[] }).person_ids).toHaveLength(25);
  });

  it('a seller writes why it is worth it and asks for approval', async () => {
    serveAccount({ scopes: [...SELLER, ...REQUESTER] });
    const seen = serveEnrichment({ create: () => HttpResponse.json({ ...REQUEST, status: 'flagged', status_text: 'Waiting for approval', joined: false }, { status: 201 }) });
    renderApp(URL);
    const { user, dialog } = await openDialog();
    expect(within(dialog).queryByRole('button', { name: 'Run enrichment' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    const reason = within(dialog).getByRole('textbox', { name: 'Why is this worth it?' });
    expect(within(dialog).getByText('Say why this is worth the spend.')).toBeInTheDocument();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(seen.posted).toEqual([]);
    await user.type(reason, 'They re-issue the RFP in December');
    await user.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(await screen.findByText('Sent for approval. A leader will see it in Enrichment requests.')).toBeInTheDocument();
    expect(seen.posted).toEqual([{ kind: 'people_for_roles', provider_key: 'apollo', roles: ['technical_buyer'], reason: 'They re-issue the RFP in December' }]);
  });

  it('shows the API words when the create refuses', async () => {
    serveAccount({ scopes: [...SELLER, ...REQUESTER] });
    serveEnrichment({ create: () => problem(400, 'Say why this is worth the spend.') });
    renderApp(URL);
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByRole('textbox', { name: 'Why is this worth it?' }), '   x');
    await user.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(await within(dialog).findByText('Say why this is worth the spend.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Enrich Miami-Dade County DTPW' })).toBeInTheDocument();
  });

  it('joining an open request says so', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER] });
    serveEnrichment({ create: () => HttpResponse.json({ ...REQUEST, joined: true }) });
    renderApp(URL);
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Run enrichment' }));
    expect(await screen.findByText("Already requested. You'll see the results here too.")).toBeInTheDocument();
  });

  it('there is no Enrich without enrichment:request', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, 'enrichment:approve'] });
    renderApp(URL);
    await screen.findByRole('heading', { level: 1, name: 'Miami-Dade County DTPW' });
    expect(screen.queryByRole('button', { name: 'Enrich' })).toBeNull();
  });

  it('the peek has Enrich, which opens the same dialog for the peeked account', async () => {
    serveQueue({ scopes: [...LEADER, ...APPROVER] });
    serveAccount({ scopes: [...LEADER, ...APPROVER] });
    const seen = serveEnrichment();
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    const user = userEvent.setup();
    await user.click(within(peek).getByRole('button', { name: 'Enrich' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enrich Miami-Dade County DTPW' });
    await within(dialog).findByText('Up to 3 credits, about $0.30 · Sample');
    await user.click(within(dialog).getByRole('button', { name: 'Run enrichment' }));
    expect(await screen.findByText('Enrichment started for Miami-Dade County DTPW. New signals appear in about 2 minutes.')).toBeInTheDocument();
    expect(seen.posted).toHaveLength(1);
  });

  it('the peek has no Enrich without enrichment:request', async () => {
    serveQueue();
    renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    expect(within(peek).queryByRole('button', { name: 'Enrich' })).toBeNull();
  });
});

describe('Account enrichment notice', () => {
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const old: EnrichmentRequest = {
    ...REQUEST,
    id: 'enr_old',
    kind: 'company_firmographics',
    kind_label: 'Company facts',
    status: 'completed',
    status_text: 'Found 4',
    created_at: at(10),
    decided_at: at(10),
  };
  const recent: EnrichmentRequest = { ...old, id: 'enr_recent', kind: 'signals_refresh', kind_label: 'Fresh signals', provider_name: 'Vibe Prospecting', status: 'declined', status_text: 'Declined: Not now', created_at: at(9), decided_at: at(2) };
  const flagged: EnrichmentRequest = { ...old, id: 'enr_flag', kind: 'website_read', kind_label: 'Read the website', provider_name: 'Company website', status: 'flagged', status_text: 'Waiting for approval', created_at: at(20), decided_at: null };

  it('lists open and recent requests, one line each, and leaves out older ones', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...REQUESTER] });
    const seen = serveEnrichment({ requests: () => [{ ...REQUEST, status: 'approved', status_text: 'Waiting for budget: Apollo monthly limit reached' }, recent, flagged, old] });
    renderApp(URL);
    const notice = await screen.findByRole('list', { name: 'Enrichment' });
    await waitFor(() =>
      expect(within(notice).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
        'People for buying roles from Apollo: Waiting for budget: Apollo monthly limit reached',
        'Fresh signals from Vibe Prospecting: Declined: Not now',
        'Read the website from Company website: Waiting for approval',
      ]),
    );
    expect(seen.lists[0]!.searchParams.get('account_id')).toBe('acc_mdc');
  });

  it('shows nothing with no requests, and reads none without enrichment:request', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...REQUESTER] });
    const seen = serveEnrichment({ requests: () => [old] });
    renderApp(URL);
    await screen.findByRole('heading', { level: 1, name: 'Miami-Dade County DTPW' });
    await waitFor(() => expect(seen.lists).toHaveLength(1));
    expect(screen.queryByRole('list', { name: 'Enrichment' })).toBeNull();
  });

  it('refreshes every 10 seconds while a request runs, and stops once none is open', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...REQUESTER] });
    let status: EnrichmentRequest['status'] = 'running';
    const seen = serveEnrichment({ requests: () => [{ ...REQUEST, status, status_text: status === 'running' ? 'Running' : 'Found 2' }] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp(URL);
      const notice = await screen.findByRole('list', { name: 'Enrichment' });
      expect(notice).toHaveTextContent('People for buying roles from Apollo: Running');
      const before = seen.lists.length;
      await vi.advanceTimersByTimeAsync(10_100);
      await waitFor(() => expect(seen.lists.length).toBeGreaterThan(before));
      status = 'completed';
      await vi.advanceTimersByTimeAsync(10_100);
      await waitFor(() => expect(screen.getByRole('list', { name: 'Enrichment' })).toHaveTextContent('People for buying roles from Apollo: Found 2'));
      const settled = seen.lists.length;
      await vi.advanceTimersByTimeAsync(25_000);
      expect(seen.lists.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the account again when a request finishes, so the people it found show (review I4)', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...REQUESTER] });
    const found = { ...ACCOUNT.people[0]!, id: 'per_new', first_name: 'Nia', last_name: 'Found' };
    let status: EnrichmentRequest['status'] = 'running';
    let accountReads = 0;
    server.use(
      http.get('/api/v1/accounts/acc_mdc', () => {
        accountReads++;
        return HttpResponse.json(status === 'running' ? ACCOUNT : { ...ACCOUNT, people: [...ACCOUNT.people, found] });
      }),
    );
    const seen = serveEnrichment({ requests: () => [{ ...REQUEST, status, status_text: status === 'running' ? 'Running' : 'Found 1' }] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp(URL);
      await screen.findByRole('list', { name: 'Enrichment' });
      expect(screen.queryByText(/Nia Found/)).toBeNull();
      const reads = accountReads;
      const lists = seen.lists.length;
      status = 'completed';
      await vi.advanceTimersByTimeAsync(10_100);
      await waitFor(() => expect(screen.getByRole('list', { name: 'Enrichment' })).toHaveTextContent('Found 1'));
      await waitFor(() => expect(accountReads).toBeGreaterThan(reads));
      expect(await screen.findAllByText(/Nia Found/)).not.toHaveLength(0);
      // The notice itself is not read again for the refresh: only its own poll read it.
      expect(seen.lists.length).toBe(lists + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new request shows in the notice after it is created', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, ...APPROVER] });
    let created = false;
    serveEnrichment({
      requests: () => (created ? [{ ...REQUEST, status: 'approved', status_text: 'Starting' }] : []),
      create: () => {
        created = true;
        return HttpResponse.json({ ...REQUEST, status: 'approved', status_text: 'Starting', joined: false }, { status: 201 });
      },
    });
    renderApp(URL);
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Run enrichment' }));
    expect(await screen.findByRole('list', { name: 'Enrichment' })).toHaveTextContent('People for buying roles from Apollo: Starting');
  });
});
