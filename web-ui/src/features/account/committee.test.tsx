import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { REQUESTER, serveEnrichment } from '../enrichment/testing';
import type { Engagement } from './api';
import { ACCOUNT, ASSIGNED, COMMITTEE, COMMITTEE_EMPTY, PAGE_LEADER, serveAccount } from './testing';

const URL = '/t/taazaa/accounts/acc_mdc';
const WITH_FIND = [...PAGE_LEADER, ...REQUESTER];
const rail = async () => within(await screen.findByRole('complementary', { name: 'Account details' }));

function serveRoles() {
  const keys = [
    ['business_owner', 'Business owner'],
    ['commercial_buyer', 'Commercial buyer'],
    ['technical_buyer', 'Technical buyer'],
    ['procurement', 'Procurement'],
  ];
  server.use(http.get('/api/v1/buying-roles', () => HttpResponse.json({ data: keys.map(([key, label]) => ({ key, label })) })));
}

beforeEach(() => localStorage.clear());

const PEOPLE = ['per_met', 'per_rep', 'per_em', 'per_not', 'per_gone'].map((id, i) => ({
  id,
  first_name: ['Mia', 'Ravi', 'Eli', 'Nia', 'Gus'][i]!,
  last_name: 'Test',
  title: null,
  is_primary: false,
  decision_note: null,
  roles: [],
}));
const ENGAGED: Engagement = {
  people: [
    { person_id: 'per_met', state: 'met', at: '2026-11-04T15:00:00Z' },
    { person_id: 'per_rep', state: 'replied', at: '2026-11-03T15:00:00Z' },
    { person_id: 'per_em', state: 'emailed', at: null },
    { person_id: 'per_not', state: 'not_contacted', at: null },
  ],
  engaged: 2,
  total: 5,
  gap_role: null,
};
const rowOf = (r: ReturnType<typeof within>, name: string) => r.getByText(`${name} Test`).closest('li')!;

describe('Committee engagement', () => {
  it('each person reads Met, Replied, Emailed or Not contacted, and a person the answer left out reads Not contacted', async () => {
    serveAccount({ account: { ...ACCOUNT, people: PEOPLE }, review: ASSIGNED, engagement: ENGAGED });
    renderApp(URL);
    const r = await rail();
    expect(await within(rowOf(r, 'Mia')).findByText('Met Nov 4')).toBeInTheDocument();
    expect(within(rowOf(r, 'Ravi')).getByText('Replied Nov 3')).toBeInTheDocument();
    expect(within(rowOf(r, 'Eli')).getByText('Emailed, no reply')).toBeInTheDocument();
    expect(within(rowOf(r, 'Nia')).getByText('Not contacted')).toBeInTheDocument();
    expect(within(rowOf(r, 'Gus')).getByText('Not contacted')).toBeInTheDocument();
  });

  it('the dots are green for met and replied, amber for emailed and gray for not contacted', async () => {
    serveAccount({ account: { ...ACCOUNT, people: PEOPLE }, review: ASSIGNED, engagement: ENGAGED });
    renderApp(URL);
    const r = await rail();
    await within(rowOf(r, 'Mia')).findByText('Met Nov 4');
    const dot = (name: string) => rowOf(r, name).querySelector('[data-dot]')!.className;
    expect(dot('Mia')).toMatch(/good/);
    expect(dot('Ravi')).toMatch(/good/);
    expect(dot('Eli')).toMatch(/amber/);
    expect(dot('Nia')).toMatch(/gray/);
  });

  it('the review page (before assignment) shows no dots and never reads the engagement', async () => {
    const asked: string[] = [];
    serveAccount({ account: { ...ACCOUNT, people: PEOPLE }, engagement: ENGAGED });
    server.use(http.get('/api/v1/accounts/acc_mdc/engagement', ({ request }) => (asked.push(request.url), HttpResponse.json(ENGAGED))));
    renderApp(URL);
    const r = await rail();
    expect(await r.findByText('Mia Test')).toBeInTheDocument();
    await new Promise((res) => setTimeout(res, 150));
    expect(document.querySelectorAll('[data-dot]')).toHaveLength(0);
    expect(r.queryByText('Not contacted')).toBeNull();
    expect(asked).toHaveLength(0);
  });

  it('when the engagement fails, the committee has no dots and no engagement text', async () => {
    serveAccount({ account: { ...ACCOUNT, people: PEOPLE }, review: ASSIGNED, engagement: null });
    renderApp(URL);
    const r = await rail();
    expect(await r.findByText('Mia Test')).toBeInTheDocument();
    await new Promise((res) => setTimeout(res, 150));
    expect(document.querySelectorAll('[data-dot]')).toHaveLength(0);
    expect(r.queryByText('Not contacted')).toBeNull();
  });
});

describe('Committee coverage and Find', () => {
  it('the rail shows the summary under the title and a gap row per missing role', async () => {
    serveAccount({ scopes: WITH_FIND });
    renderApp(URL);
    const r = await rail();
    expect(await r.findByText('Modernization Blueprint: 1 of 3 roles covered')).toBeInTheDocument();
    expect(r.getByText('Jarice Rodriguez')).toBeInTheDocument();
    expect(r.getByText('No commercial buyer yet')).toBeInTheDocument();
    expect(r.getByText('No technical buyer yet')).toBeInTheDocument();
    expect(r.getByText('No procurement yet · Optional')).toBeInTheDocument();
    expect(r.getAllByRole('button', { name: /^Find / })).toHaveLength(3);
  });

  it('says Core roles with no offer', async () => {
    serveAccount({ committee: { ...COMMITTEE, offer: null } });
    renderApp(URL);
    expect(await (await rail()).findByText('Core roles: 1 of 3 roles covered')).toBeInTheDocument();
  });

  it('says Core roles when the offer fell back to the core three', async () => {
    serveAccount({ committee: { ...COMMITTEE, core_roles: true } });
    renderApp(URL);
    expect(await (await rail()).findByText('Core roles: 1 of 3 roles covered')).toBeInTheDocument();
  });

  it('an empty rail whose committee failed to load uses the same core-three wording as the loaded one', async () => {
    serveAccount({ account: { ...ACCOUNT, people: [] } });
    server.use(http.get('/api/v1/accounts/acc_mdc/committee', () => HttpResponse.json({ title: 'Down' }, { status: 500 })));
    renderApp(URL);
    expect(await (await rail()).findByText('No people yet. Add someone you know, or Enrich will look for a business owner, a commercial buyer and a technical buyer.')).toBeInTheDocument();
  });

  it('Find on a gap opens Enrich with only that role ticked', async () => {
    serveAccount({ scopes: WITH_FIND });
    serveEnrichment();
    serveRoles();
    renderApp(URL);
    const r = await rail();
    await userEvent.click(await r.findByRole('button', { name: 'Find technical buyer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enrich Miami-Dade County DTPW' });
    const roles = within(dialog).getByRole('group', { name: 'Buying roles' });
    expect(await within(roles).findByRole('checkbox', { name: 'Technical buyer' })).toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Commercial buyer' })).not.toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Business owner' })).not.toBeChecked();
  });

  it('the checklist names the required gaps, and Find with Enrich ticks them all', async () => {
    serveAccount({ scopes: WITH_FIND });
    serveEnrichment();
    serveRoles();
    renderApp(URL);
    const card = await screen.findByRole('region', { name: 'Before you approve' });
    expect(within(card).getByText('Buying committee has no commercial buyer or technical buyer.')).toBeInTheDocument();
    expect(within(card).queryByText(/procurement/i)).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Find with Enrich' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enrich Miami-Dade County DTPW' });
    const roles = within(dialog).getByRole('group', { name: 'Buying roles' });
    expect(await within(roles).findByRole('checkbox', { name: 'Commercial buyer' })).toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Technical buyer' })).toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Business owner' })).not.toBeChecked();
  });

  it('the checklist joins three gaps with a comma and or', async () => {
    serveAccount({ committee: COMMITTEE_EMPTY });
    renderApp(URL);
    const card = await screen.findByRole('region', { name: 'Before you approve' });
    expect(within(card).getByText('Buying committee has no business owner, commercial buyer or technical buyer.')).toBeInTheDocument();
  });

  it('the checklist shows with only a gap (no conflict, no intro)', async () => {
    serveAccount({ score: null, conflicts: [] });
    renderApp(URL);
    const card = await screen.findByRole('region', { name: 'Before you approve' });
    expect(card).toHaveTextContent('Buying committee has no commercial buyer or technical buyer.');
    expect(within(card).queryByRole('button', { name: 'Resolve' })).toBeNull();
  });

  it('an empty committee uses the dynamic copy, and Find with Enrich finds all the required roles', async () => {
    serveAccount({ scopes: WITH_FIND, account: { ...ACCOUNT, people: [] }, committee: COMMITTEE_EMPTY });
    serveEnrichment();
    serveRoles();
    renderApp(URL);
    const r = await rail();
    expect(await r.findByText('No people yet. Add someone you know, or Enrich will look for a business owner, a commercial buyer and a technical buyer.')).toBeInTheDocument();
    await userEvent.click(r.getByRole('button', { name: 'Find with Enrich' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enrich Miami-Dade County DTPW' });
    const roles = within(dialog).getByRole('group', { name: 'Buying roles' });
    expect(await within(roles).findByRole('checkbox', { name: 'Business owner' })).toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Commercial buyer' })).toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Technical buyer' })).toBeChecked();
    expect(within(roles).getByRole('checkbox', { name: 'Procurement' })).not.toBeChecked();
  });

  it('without enrichment:request there is coverage and gaps but no Find', async () => {
    serveAccount();
    renderApp(URL);
    const r = await rail();
    expect(await r.findByText('No technical buyer yet')).toBeInTheDocument();
    expect(r.queryByRole('button', { name: /^Find/ })).toBeNull();
    const card = await screen.findByRole('region', { name: 'Before you approve' });
    expect(card).toHaveTextContent('Buying committee has no commercial buyer or technical buyer.');
    expect(within(card).queryByRole('button', { name: 'Find with Enrich' })).toBeNull();
  });

  it('without enrichment:request the empty committee has no Find with Enrich', async () => {
    serveAccount({ account: { ...ACCOUNT, people: [] }, committee: COMMITTEE_EMPTY });
    renderApp(URL);
    const r = await rail();
    await r.findByText(/Enrich will look for a business owner/);
    expect(r.queryByRole('button', { name: 'Find with Enrich' })).toBeNull();
  });

  it('keeps the people list when the committee cannot be read', async () => {
    serveAccount();
    server.use(http.get('/api/v1/accounts/acc_mdc/committee', () => HttpResponse.json({}, { status: 500 })));
    renderApp(URL);
    const r = await rail();
    expect(await r.findByText('Jarice Rodriguez')).toBeInTheDocument();
    expect(r.queryByText(/roles covered/)).toBeNull();
    expect(r.queryByText(/^No .* yet/)).toBeNull();
  });

  it('the assigned view shows the same rail and Find', async () => {
    serveAccount({ scopes: WITH_FIND, review: ASSIGNED });
    serveEnrichment();
    serveRoles();
    renderApp(URL);
    const r = await rail();
    expect(await r.findByText('Modernization Blueprint: 1 of 3 roles covered')).toBeInTheDocument();
    await userEvent.click(r.getByRole('button', { name: 'Find commercial buyer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enrich Miami-Dade County DTPW' });
    expect(await within(within(dialog).getByRole('group', { name: 'Buying roles' })).findByRole('checkbox', { name: 'Commercial buyer' })).toBeChecked();
  });

  it('reads the committee again after the dialog creates a request, and a gap with no one found stays a gap', async () => {
    serveAccount({ scopes: [...WITH_FIND, 'enrichment:approve'] });
    serveEnrichment();
    serveRoles();
    let reads = 0;
    server.use(
      http.get('/api/v1/accounts/acc_mdc/committee', () => {
        reads++;
        return HttpResponse.json(COMMITTEE);
      }),
    );
    renderApp(URL);
    const r = await rail();
    await userEvent.click(await r.findByRole('button', { name: 'Find technical buyer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enrich Miami-Dade County DTPW' });
    await within(within(dialog).getByRole('group', { name: 'Buying roles' })).findByRole('checkbox', { name: 'Technical buyer' });
    const before = reads;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run enrichment' }));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await r.findByText('No technical buyer yet')).toBeInTheDocument();
  });
});
