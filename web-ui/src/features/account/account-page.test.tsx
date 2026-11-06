import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp, serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import { serveQueue } from '../review/testing';
import { crmSentence } from './RightRail';
import { ACCOUNT, ASSIGNED, COMMITTEE, COMMITTEE_EMPTY, EMPTY_BRIEF, FACTS, PAGE_LEADER, REVIEW, SCORE, SELLER, serveAccount, serveCoastline } from './testing';

const URL_BASE = 'http://app';
const params = (href: string) => new URL(href, URL_BASE).searchParams;
const pathOf = (href: string) => new URL(href, URL_BASE).pathname;
const header = async () => (await screen.findByRole('heading', { level: 1, name: 'Miami-Dade County DTPW' })).closest('div[class]')!.parentElement!.parentElement!;

beforeEach(() => localStorage.clear());

describe('Account page header', () => {
  it('shows the account card, origin, pills, status and the review actions, with no Enrich without enrichment:request', async () => {
    serveAccount();
    renderApp('/t/taazaa/accounts/acc_mdc');
    const card = await header();
    expect(card).toHaveTextContent('Ready for review');
    expect(card).toHaveTextContent('Public agency · Miami, FL · miamidade.gov');
    expect(card).toHaveTextContent('PracticeData and Engineering for AI Readiness');
    expect(card).toHaveTextContent('Best offerModernization Blueprint');
    expect(card).toHaveTextContent('From RFP Watch (Marcus Lee · GovSpend) · Batch B-1042 · Arrived Oct 24, 2026');
    expect(within(card).getByRole('button', { name: 'Send back' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Approve and assign' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enrich' })).toBeNull();
  });

  it('shows Enrich with enrichment:request', async () => {
    serveAccount({ scopes: [...PAGE_LEADER, 'enrichment:request'] });
    server.use(http.get('/api/v1/enrichment-requests', () => HttpResponse.json({ data: [], next_cursor: null })));
    renderApp('/t/taazaa/accounts/acc_mdc');
    const card = await header();
    expect(within(card).getByRole('button', { name: 'Enrich' })).toBeInTheDocument();
  });

  it('names who set a reviewer status, and hides actions the person cannot take', async () => {
    serveAccount({ scopes: SELLER, review: { ...REVIEW, status: { key: 'needs_review', label: 'In review', color: 'amber', set_by: 'reviewer', changed_at: null, changed_by_name: 'Dana Whitfield' } } });
    renderApp('/t/taazaa/accounts/acc_mdc');
    const card = await header();
    expect(card).toHaveTextContent('In review by Dana');
    expect(within(card).queryByRole('button', { name: 'Send back' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Approve and assign' })).toBeNull();
  });

  it.each([
    ['queue', 'Review queue', '/t/taazaa/queue'],
    ['my', 'My accounts', '/t/taazaa/my'],
    ['all', 'All accounts', '/t/taazaa/accounts'],
  ])('the breadcrumb from=%s says %s', async (from, label, href) => {
    serveAccount();
    renderApp(`/t/taazaa/accounts/acc_mdc?from=${from}`);
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: label })).toHaveAttribute('href', href);
    expect(crumbs).toHaveTextContent('Miami-Dade County DTPW');
  });

  it('a direct link has no "{i} of {n}"', async () => {
    serveAccount();
    renderApp('/t/taazaa/accounts/acc_mdc?from=queue');
    await header();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByText(/ of 3$/)).toBeNull();
  });

  it('from the peek: Open full page carries from=queue and the filters, then Next goes to the next queue row', async () => {
    serveQueue();
    serveAccount();
    serveCoastline();
    serveCoastline();
    const app = renderApp('/t/taazaa/queue?tier=act_now&peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    const link = within(peek).getByRole('link', { name: 'Open full page' });
    expect(pathOf(link.getAttribute('href')!)).toBe('/t/taazaa/accounts/acc_mdc');
    expect(params(link.getAttribute('href')!).get('from')).toBe('queue');
    expect(params(link.getAttribute('href')!).get('tier')).toBe('act_now');
    await userEvent.click(link);
    await header();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Review queue' })).toHaveAttribute('href', '/t/taazaa/queue?tier=act_now');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Coastline Credit Union' })).toBeInTheDocument();
    expect(pathOf(app.path())).toBe('/t/taazaa/accounts/acc_ccu');
    expect(params(app.path()).get('from')).toBe('queue');
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
  });

  it('shows the declined, two companies and needs-a-decision notices', async () => {
    serveAccount({
      review: {
        ...REVIEW,
        flags: {
          declined_by_seller: { assignment_id: 'asg_0', seller_user_id: 'usr_ash', seller_name: 'Ash Patel', reason_key: 'territory', reason_label: 'Outside my territory', at: '2026-10-25T10:00:00Z' },
          handoff: { handoff_id: 'h', state: 'needs_decision', reason: 'Rita Gomez owns an open deal on this company.', at: '2026-10-25T10:00:00Z' },
        },
      },
    });
    renderApp('/t/taazaa/accounts/acc_mdc');
    expect(await screen.findByText('Declined by Ash Patel on Oct 25, 2026: Outside my territory. Assign someone else or send it back.')).toBeInTheDocument();
    expect(screen.getByText('HubSpot needs a decision').parentElement).toHaveTextContent('Rita Gomez owns an open deal on this company.');
  });
});

describe('Stage tracker', () => {
  it('uses the API names and dates, with Waiting on you for a reviewer', async () => {
    serveAccount();
    renderApp('/t/taazaa/accounts/acc_mdc');
    const steps = await screen.findByRole('list', { name: 'Stages' });
    const items = within(steps).getAllByRole('listitem');
    await waitFor(() => expect(items.map((i) => i.textContent)).toEqual(['ArrivedOct 24, 2026', 'ReviewedWaiting on you', 'Assigned', 'Engaged', 'Opportunity', 'Won']));
    expect(items[0]).toHaveAttribute('aria-current', 'step');
  });

  it('says Next, not Waiting on you, for someone who does not review', async () => {
    serveAccount({ scopes: SELLER });
    renderApp('/t/taazaa/accounts/acc_mdc');
    const steps = await screen.findByRole('list', { name: 'Stages' });
    expect(within(steps).getAllByRole('listitem')[1]).toHaveTextContent('ReviewedNext');
  });
});

describe('Source trust tile', () => {
  it('shows the number and the note, with the breakdown as hover text', async () => {
    serveAccount();
    server.use(
      http.get('/api/v1/accounts/acc_mdc/score', () =>
        HttpResponse.json({
          ...SCORE,
          tiles: SCORE.tiles.map((t) => (t.key === 'source_trust' ? { ...t, value: 72, max: 100, note: 'RFP Watch: 6 won of 41 sent', breakdown: 'Person 0.64, agent 0.71, vendor 0.55' } : t)),
        }),
      ),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const scores = await screen.findByRole('region', { name: 'Scores' });
    const tile = (await within(scores).findByText('RFP Watch: 6 won of 41 sent')).closest('div[title]')!;
    expect(tile).toHaveAttribute('title', 'Person 0.64, agent 0.71, vendor 0.55');
    expect(tile).toHaveTextContent('Source trust72 / 100');
  });
});

describe('Review view sections', () => {
  it('shows the recommendation, the warm intro, the score strip, why now and the facts', async () => {
    serveAccount();
    renderApp('/t/taazaa/accounts/acc_mdc');
    const rec = await screen.findByRole('region', { name: "Scout's recommendation" });
    expect(rec).toHaveTextContent('Approve and assign to someone who covers Data and Engineering for AI Readiness.');
    expect(rec).toHaveTextContent('The cancelled transit software RFP is being re-issued in December.');
    expect(rec).toHaveTextContent('Written by Claude');

    expect(await screen.findByRole('region', { name: 'Before you approve' })).toHaveTextContent('Warm intro from Ash Patel (someone on our team knows them), +8');

    const scores = await screen.findByRole('region', { name: 'Scores' });
    expect(await within(scores).findByText('Arrives with enrichment')).toBeInTheDocument();
    expect(scores).toHaveTextContent('Not enough data yet');
    expect(scores).toHaveTextContent('Priority79 / 100Act now needs a priority of 75, fit 60 and buying intent 50.');

    // Older scores have no breakdown: the old note, no hover text.
    expect(within(scores).getByText('Source trust').closest('div')).not.toHaveAttribute('title');

    const why = screen.getByRole('region', { name: 'Why now' });
    expect(why).toHaveTextContent('2 signals · newest first');
    expect(why).toHaveTextContent('Oct 14, 2026RFP re-issue expected in December');
    // The link says which source found it; with no source name, the site's host.
    expect(within(why).getByRole('link', { name: 'RFP Watch' })).toHaveAttribute('href', 'https://www.miamidade.gov/procurement/notice');
    expect(within(why).getByRole('link', { name: 'govspend.com' })).toHaveAttribute('href', 'https://www.govspend.com/budget');
    expect(why).not.toHaveTextContent('Undated research');

    const facts = screen.getByRole('region', { name: 'Account facts' });
    expect(await within(facts).findByText('3,800')).toBeInTheDocument();
    // Labels come from the API.
    expect(facts).toHaveTextContent('Staff3,800GovSpend · Sep 1, 2026');
    expect(facts).toHaveTextContent('Buying processFormal RFP with Board approvalRFP Watch · Oct 1, 2026');
    expect(facts).not.toHaveTextContent('jr@miamidade.gov');
  });

  it('shows a date-only signal and fact on their own day in a US workspace', async () => {
    serveAccount({
      account: { ...ACCOUNT, signals: [{ ...ACCOUNT.signals[0]!, occurred_at: '2026-10-14T00:00:00.000Z' }] },
      facts: [{ ...FACTS[0]!, observed_at: '2026-09-01T00:00:00.000Z' }],
    });
    serveMe({ taazaa: { scopes: PAGE_LEADER, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/Los_Angeles' } } });
    renderApp('/t/taazaa/accounts/acc_mdc');
    const why = await screen.findByRole('region', { name: 'Why now' });
    expect(why).toHaveTextContent('Oct 14, 2026RFP re-issue expected in December');
    const facts = screen.getByRole('region', { name: 'Account facts' });
    expect(await within(facts).findByText('GovSpend · Sep 1, 2026')).toBeInTheDocument();
  });

  it('has no Before you approve card without a warm intro, and says when the account is not scored', async () => {
    serveAccount({ score: null, committee: { ...COMMITTEE, roles: COMMITTEE.roles.map((r) => ({ ...r, status: 'covered' as const })), gaps: [] } });
    renderApp('/t/taazaa/accounts/acc_mdc');
    expect(await screen.findByText("Scout hasn't scored this account yet. Scores show here once it has.")).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Before you approve' })).toBeNull();
  });

  it('shows the Building card and the section empties before the first draft', async () => {
    serveAccount({ brief: EMPTY_BRIEF, account: { ...ACCOUNT, people: [], signals: [] }, facts: [], committee: COMMITTEE_EMPTY });
    renderApp('/t/taazaa/accounts/acc_mdc');
    expect(await screen.findByText('Scout is still building this brief')).toBeInTheDocument();
    expect(screen.getByText(/Scores, dated signals and the brief appear here as enrichment finishes\./)).toBeInTheDocument();
    expect(screen.getByText('No dated signals yet. Signals show here with their date and a link to where Scout found them.')).toBeInTheDocument();
    expect(screen.getByText('Overview, approach, value angle and risks get drafted once Scout has at least two signals.')).toBeInTheDocument();
    expect(screen.getByText('No people yet. Add someone you know, or Enrich will look for a business owner, a commercial buyer and a technical buyer.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: "Scout's recommendation" })).toBeNull();
  });

  it('lists the buying committee with role labels and adds a person with a role key', async () => {
    serveAccount();
    let body: unknown = null;
    server.use(
      http.post('/api/v1/accounts/acc_mdc/people', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ arrival_id: 'arr_1', person_id: 'per_new' }, { status: 201 });
      }),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const committee = await screen.findByRole('region', { name: 'Buying committee' });
    expect(committee).toHaveTextContent('Jarice Rodriguez');
    expect(committee).toHaveTextContent('Business owner');
    expect(committee).toHaveTextContent('Warm intro through Ash Patel');
    await userEvent.click(within(committee).getByRole('button', { name: 'Add a person' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a person' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent("Add the person's name.");
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Dev Ramnath');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'IT Director');
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Role' })).toBeEnabled());
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Role' }), 'Technical buyer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Added Dev Ramnath to the buying committee.')).toBeInTheDocument();
    expect(body).toEqual({ name: 'Dev Ramnath', title: 'IT Director', buying_role: 'technical_buyer' });
  });

  it('shows the API words when adding a person fails, and no Add a person without people:write', async () => {
    serveAccount();
    server.use(http.post('/api/v1/accounts/acc_mdc/people', () => problem(400, 'Must be an email address.')));
    renderApp('/t/taazaa/accounts/acc_mdc');
    const committee = await screen.findByRole('region', { name: 'Buying committee' });
    await userEvent.click(within(committee).getByRole('button', { name: 'Add a person' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a person' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Dev');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add person' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Must be an email address.');
  });

  it('shows where it came from and the HubSpot check, and checks again', async () => {
    serveAccount();
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:check-crm'), () =>
        HttpResponse.json({ exists: true, owner_name: 'Rita Gomez', lifecycle: 'none', open_deals: 0, open_deal: null, checked_at: '2026-10-31T10:00:00Z', hubspot_url: null }),
      ),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const from = await screen.findByRole('region', { name: 'Where it came from' });
    expect(from).toHaveTextContent('RFP Watch');
    expect(from).toHaveTextContent('Owner: Marcus Lee');
    const crm = screen.getByRole('region', { name: 'In HubSpot' });
    expect(await within(crm).findByText('Not in HubSpot yet.')).toBeInTheDocument();
    await userEvent.click(within(crm).getByRole('button', { name: 'Check again' }));
    expect(await within(crm).findByText('Company exists, owned by Rita Gomez.')).toBeInTheDocument();
  });

  it('says HubSpot did not answer when the check fails', async () => {
    serveAccount();
    server.use(http.post(exactly('/api/v1/accounts/acc_mdc:check-crm'), () => problem(503, "HubSpot didn't answer. Try again in a minute.")));
    renderApp('/t/taazaa/accounts/acc_mdc');
    const crm = await screen.findByRole('region', { name: 'In HubSpot' });
    await userEvent.click(within(crm).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText("HubSpot didn't answer. Try again in a minute.")).toBeInTheDocument();
  });

  it('words the four HubSpot variants', () => {
    const money = (m: number) => `$${m / 100}`;
    const date = () => 'Aug 2, 2026';
    const base = { lifecycle: 'none' as const, checked_at: 'x', hubspot_url: null };
    expect(
      crmSentence({ ...base, exists: true, owner_name: 'Rita Gomez', open_deals: 1, open_deal: { name: 'Transit data audit', amount_cents: 4800000, currency: 'USD', last_activity_at: 'x' } }, money, date),
    ).toBe('Company exists. Open deal owned by Rita Gomez: Transit data audit, $48000, last activity Aug 2, 2026.');
    expect(crmSentence({ ...base, exists: true, owner_name: null, open_deals: 0, open_deal: null }, money, date)).toBe('Company exists with no owner and no open deal. Scout can set the owner.');
    expect(crmSentence({ ...base, exists: true, owner_name: 'Rita Gomez', open_deals: 0, open_deal: null }, money, date)).toBe('Company exists, owned by Rita Gomez.');
    expect(crmSentence({ ...base, exists: false, owner_name: null, open_deals: 0, open_deal: null }, money, date)).toBe('Not in HubSpot yet.');
  });
});

describe('Account page states', () => {
  it('shows the loading skeleton', async () => {
    serveAccount();
    server.use(http.get('/api/v1/accounts/acc_mdc', async () => {
      await delay('infinite');
      return HttpResponse.json(ACCOUNT);
    }));
    renderApp('/t/taazaa/accounts/acc_mdc');
    expect(await screen.findByText('Loading the brief, signals and buying committee')).toBeInTheDocument();
  });

  it('says the account is not in the workspace on a 404, with a link back', async () => {
    serveAccount();
    server.use(http.get('/api/v1/accounts/acc_mdc', () => problem(404, 'That account was not found.')));
    renderApp('/t/taazaa/accounts/acc_mdc?from=my');
    expect(await screen.findByText("This account isn't in your workspace, or you don't have access to it.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to My accounts' })).toHaveAttribute('href', '/t/taazaa/my');
  });

  it('says the account did not open, with the API reason, the ref and Try again', async () => {
    serveAccount();
    let calls = 0;
    server.use(
      http.get('/api/v1/accounts/acc_mdc', () => {
        calls += 1;
        return calls === 1 ? problem(500, 'Scout could not read this account.', { ref: 'a-22e90b' }) : HttpResponse.json(ACCOUNT);
      }),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("This account didn't open");
    expect(alert).toHaveTextContent('Scout could not read this account.');
    expect(alert).toHaveTextContent('acc_mdc · Error ref a-22e90b');
    expect(within(alert).queryByRole('button', { name: 'Open next account' })).toBeNull();
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Miami-Dade County DTPW' })).toBeInTheDocument();
  });

  it('offers Open next account when it came from the queue', async () => {
    serveQueue();
    serveAccount();
    serveCoastline();
    const app = renderApp('/t/taazaa/queue?peek=acc_mdc');
    const peek = await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' });
    server.use(http.get('/api/v1/accounts/acc_mdc', () => problem(500, 'Scout could not read this account.')));
    await userEvent.click(within(peek).getByRole('link', { name: 'Open full page' }));
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Open next account' }));
    await waitFor(() => expect(pathOf(app.path())).toBe('/t/taazaa/accounts/acc_ccu'));
  });
});

describe('Account page actions', () => {
  it('Send back from the page opens the next queue account', async () => {
    serveQueue();
    serveAccount();
    serveCoastline();
    let body: unknown = null;
    server.use(
      http.patch('/api/v1/accounts/acc_mdc/review-status', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({});
      }),
    );
    const app = renderApp('/t/taazaa/queue?peek=acc_mdc');
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Miami-Dade County DTPW' })).getByRole('link', { name: 'Open full page' }));
    await userEvent.click(within(await header()).getByRole('button', { name: 'Send back' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back to RFP Watch (Marcus Lee)' });
    await userEvent.click(await within(dialog).findByRole('radio', { name: 'Not our kind of customer' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send back to Marcus' }));
    expect(await screen.findByText('Sent back to Marcus Lee. Miami-Dade County DTPW left the queue.')).toBeInTheDocument();
    expect(body).toEqual({ to: 'sent_back', reason_key: 'not_our_kind_of_customer' });
    await waitFor(() => expect(pathOf(app.path())).toBe('/t/taazaa/accounts/acc_ccu'));
  });

  it('Send back on a direct link goes back to the queue', async () => {
    serveAccount();
    server.use(http.patch('/api/v1/accounts/acc_mdc/review-status', () => HttpResponse.json({})));
    const app = renderApp('/t/taazaa/accounts/acc_mdc');
    await userEvent.click(within(await header()).getByRole('button', { name: 'Send back' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back to RFP Watch (Marcus Lee)' });
    await userEvent.click(await within(dialog).findByRole('radio', { name: 'Not our kind of customer' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send back to Marcus' }));
    await waitFor(() => expect(pathOf(app.path())).toBe('/t/taazaa/queue'));
  });

  it('Approve and assign opens the Assign dialog for this account and assigns', async () => {
    serveAccount();
    let body: unknown = null;
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:assign'), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 'asg_1' }, { status: 202 });
      }),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    await userEvent.click(within(await header()).getByRole('button', { name: 'Approve and assign' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign Miami-Dade County DTPW' });
    expect(dialog).toHaveTextContent('Modernization Blueprint · Data and Engineering for AI Readiness');
    const go = await within(dialog).findByRole('button', { name: 'Assign to Ash Patel' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    expect(await screen.findByText('Assigned to Ash Patel. Sending Miami-Dade County DTPW to HubSpot.')).toBeInTheDocument();
    expect(body).toEqual({ seller_user_id: 'usr_ash' });
  });

  it('swaps the actions for "Assigned by Dana a moment ago" when someone else assigns it', async () => {
    serveAccount();
    const app = renderApp('/t/taazaa/accounts/acc_mdc');
    const card = await header();
    expect(within(card).getByRole('button', { name: 'Approve and assign' })).toBeInTheDocument();
    server.use(http.get('/api/v1/accounts/acc_mdc/review', () => HttpResponse.json({ ...ASSIGNED, current_assignment: { ...ASSIGNED.current_assignment!, assigned_by_name: 'Dana' } })));
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['account', 'taazaa', 'acc_mdc', 'review'] }));
    expect(await within(card).findByText('Assigned by Dana a moment ago')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Approve and assign' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Reassign' })).toBeNull();
  });

  it('swaps the actions for "Sent back by {name}" when someone else sends it back', async () => {
    serveAccount();
    const app = renderApp('/t/taazaa/accounts/acc_mdc');
    const card = await header();
    await waitFor(() => expect(app.queryClient.getQueryData(['review-statuses', 'taazaa'])).toBeTruthy());
    server.use(
      http.get('/api/v1/accounts/acc_mdc/review', () =>
        HttpResponse.json({ ...REVIEW, status: { key: 'sent_back', label: 'Sent back to source', color: 'gray', set_by: 'reviewer', changed_at: null, changed_by_name: 'Dana Whitfield' } }),
      ),
    );
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['account', 'taazaa', 'acc_mdc', 'review'] }));
    expect(await within(card).findByText('Sent back by Dana Whitfield a moment ago')).toBeInTheDocument();
  });
});
