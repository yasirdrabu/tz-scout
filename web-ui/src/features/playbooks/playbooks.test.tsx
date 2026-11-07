import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { draftPlaybook, NO_RESULTS, rfp, SELLER, servePlaybooks, WORKED, WORKED_NONE } from './testing';

describe('Playbooks list (§20)', () => {
  it('shows the title, sub and the four-step explainer', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks');
    expect(await screen.findByRole('heading', { name: 'Playbooks', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('The steps an AE follows after accepting an account. Each offer picks a playbook for each tier.')).toBeInTheDocument();
    const how = screen.getByRole('list', { name: 'How playbooks work' });
    for (const t of ['Offer and tier pick it', 'Starts on acceptance', 'Scout prepares each step', 'Stops on a result']) expect(within(how).getByText(t)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New playbook' })).toBeInTheDocument();
  });

  it('lists each playbook with its steps, channel mix, offers, running count and empty rates', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks');
    const row = (await screen.findByRole('link', { name: 'Public sector RFP' })).closest('tr')!;
    expect(row).toHaveTextContent('For agencies with an open notice.');
    expect(row).toHaveTextContent('Active');
    expect(row).toHaveTextContent('3 steps over 15 days');
    expect(row).toHaveTextContent('Email 1 · LinkedIn 1 · Call 1');
    await waitFor(() => expect(row).toHaveTextContent('Modernization Blueprint · Act now'));
    const cells = within(row).getAllByRole('cell');
    expect(cells[4]).toHaveTextContent('4');
    const draft = screen.getByRole('link', { name: 'Warm intro' }).closest('tr')!;
    expect(draft).toHaveTextContent('Draft');
    expect(draft).toHaveTextContent('1 step over 1 day');
    expect(draft).toHaveTextContent('Not assigned');
    expect(screen.getByText('Reply and meeting rates are for accounts that finished the playbook in the last 90 days.')).toBeInTheDocument();
  });

  it('list shows 40% and 20% for finished 5, replied 2, meetings 1', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks');
    const cells = within((await screen.findByRole('link', { name: 'Public sector RFP' })).closest('tr')!).getAllByRole('cell');
    expect(cells[5]).toHaveTextContent('40%');
    expect(cells[6]).toHaveTextContent('20%');
  });

  it('list shows – with nothing finished', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks');
    const cells = within((await screen.findByRole('link', { name: 'Warm intro' })).closest('tr')!).getAllByRole('cell');
    expect(cells[5]).toHaveTextContent('–');
    expect(cells[5]).not.toHaveTextContent('0%');
    expect(cells[6]).toHaveTextContent('–');
  });

  it('shows Retired for an archived playbook', async () => {
    servePlaybooks({ playbooks: [rfp({ status: 'archived', runs_on: [] })] });
    renderApp('/t/taazaa/playbooks');
    expect((await screen.findByRole('link', { name: 'Public sector RFP' })).closest('tr')).toHaveTextContent('Retired');
  });

  it('says so when there are none, and offers New playbook only to a manager', async () => {
    servePlaybooks({ playbooks: [] });
    renderApp('/t/taazaa/playbooks');
    expect(await screen.findByRole('heading', { name: 'No playbooks yet' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'New playbook' })).toHaveLength(2);
  });

  it('shows the API words and Try again when the list fails', async () => {
    servePlaybooks({ answer: { list: () => problem(500, 'The list is down.') } });
    renderApp('/t/taazaa/playbooks');
    expect(await screen.findByText("Playbooks didn't load")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows a loading line first', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks');
    expect(await screen.findByText('Loading playbooks')).toBeInTheDocument();
    await screen.findByRole('link', { name: 'Public sector RFP' });
  });

  it('gives a seller the list without New playbook', async () => {
    servePlaybooks({ scopes: SELLER });
    renderApp('/t/taazaa/playbooks');
    await screen.findByRole('link', { name: 'Public sector RFP' });
    expect(screen.queryByRole('link', { name: 'New playbook' })).toBeNull();
  });
});

describe('Playbook detail (§20)', () => {
  it('shows the breadcrumb, status, tiles and the steps with day, channel, who and tags', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    expect(await screen.findByRole('heading', { name: 'Public sector RFP', level: 1 })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Playbooks' })).toBeInTheDocument();
    const tiles = screen.getByRole('list', { name: 'Playbook numbers' });
    expect(tiles).toHaveTextContent('Running now');
    expect(tiles).toHaveTextContent('Accounts mid-playbook');
    for (const t of ['Finished', 'Replied', 'Booked a meeting', 'Won']) expect(tiles).toHaveTextContent(t);
    expect(screen.getByText('3 steps over 15 days')).toBeInTheDocument();
    const one = screen.getByText('Send the opening email').closest('li')!;
    expect(one).toHaveTextContent('Day 1');
    expect(one).toHaveTextContent('Reference the notice.');
    expect(one).toHaveTextContent('Email · Seller');
    expect(one).toHaveTextContent('Draft ready for AE');
    expect(one).toHaveTextContent('HubSpot task');
    const two = screen.getByText('Connect on LinkedIn').closest('li')!;
    expect(two).toHaveTextContent('No detail yet.');
    expect(two).toHaveTextContent('LinkedIn · Seller');
    expect(two).not.toHaveTextContent('HubSpot task');
    const three = screen.getByText('Call the sponsor').closest('li')!;
    expect(three).toHaveTextContent('Day 15');
    expect(three).toHaveTextContent('Call · Leader');
    expect(three).toHaveTextContent('HubSpot task');
  });

  it('lists where it runs, joining the offer and practice names', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    const card = await screen.findByRole('region', { name: 'Runs on' });
    await waitFor(() => expect(card).toHaveTextContent('Modernization Blueprint'));
    expect(card).toHaveTextContent('AI Transformation');
    expect(card).toHaveTextContent('Act now');
  });

  it('tells a draft to become active before it can be assigned', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks/plb_draft');
    const card = await screen.findByRole('region', { name: 'Runs on' });
    expect(card).toHaveTextContent('Make it active to assign it to an offer and tier.');
    expect(card).not.toHaveTextContent('Not assigned to any offer yet');
  });

  it('shows the rules', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    const rules = await screen.findByRole('region', { name: 'Rules' });
    expect(rules).toHaveTextContent('Starts whenWhen an AE accepts an account matched to its offer and tier.');
    expect(rules).toHaveTextContent('Stops whenThey reply or book a meeting');
    expect(rules).toHaveTextContent('Pauses whenWhen the assignment is withdrawn, or someone pauses it.');
    expect(rules).toHaveTextContent('DraftsScout drafts each email for the AE to review and send.');
  });

  it('shows the API words when it fails to load', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks/plb_gone');
    expect(await screen.findByText("This playbook didn't load")).toBeInTheDocument();
    expect(screen.getByText('That playbook was not found.')).toBeInTheDocument();
  });

  it('Duplicate toasts and opens the copy', async () => {
    const seen = servePlaybooks();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/playbooks/plb_rfp');
    await user.click(await screen.findByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByText('Public sector RFP (copy) created as a draft.')).toBeInTheDocument();
    expect(seen.some((r) => r.method === 'POST' && r.url.pathname.endsWith('plb_rfp:duplicate'))).toBe(true);
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/playbooks/plb_copy'));
    expect(await screen.findByRole('heading', { name: 'Public sector RFP (copy)', level: 1 })).toBeInTheDocument();
  });

  it('Retire confirms with the tier count, then archives', async () => {
    const seen = servePlaybooks();
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    expect(await screen.findByRole('button', { name: 'Retire' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retire' }));
    const dialog = screen.getByRole('dialog', { name: 'Retire Public sector RFP?' });
    expect(dialog).toHaveTextContent('It will be removed from 1 offer tier.');
    await user.click(within(dialog).getByRole('button', { name: 'Retire playbook' }));
    expect(await screen.findByText('Public sector RFP retired.')).toBeInTheDocument();
    expect(seen.some((r) => r.method === 'POST' && r.url.pathname.endsWith('plb_rfp:archive'))).toBe(true);
    expect(await screen.findByText('Retired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
  });

  it('Delete shows when nothing runs it: confirm, DELETE, back to the list', async () => {
    const seen = servePlaybooks();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/playbooks/plb_draft');
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'Delete Warm intro?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete playbook' }));
    expect(await screen.findByText('Warm intro deleted.')).toBeInTheDocument();
    expect(seen.some((r) => r.method === 'DELETE' && r.url.pathname === '/api/v1/playbooks/plb_draft')).toBe(true);
    await waitFor(() => expect(app.path()).toBe('/t/taazaa/playbooks'));
  });

  it("a refused Delete (409) shows the API's words and offers Retire", async () => {
    const seen = servePlaybooks({
      answer: { 'DELETE plb_draft': () => problem(409, 'This playbook has run on accounts. Retire it instead.', { slug: 'playbook-has-run' }) },
    });
    const user = userEvent.setup();
    renderApp('/t/taazaa/playbooks/plb_draft');
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete playbook' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retire Warm intro?' });
    expect(dialog).toHaveTextContent('This playbook has run on accounts. Retire it instead.');
    await user.click(within(dialog).getByRole('button', { name: 'Retire playbook' }));
    expect(await screen.findByText('Warm intro retired.')).toBeInTheDocument();
    expect(seen.some((r) => r.url.pathname.endsWith('plb_draft:archive'))).toBe(true);
  });

  it('gives a manager Edit playbook, linking to the edit form', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    const link = (await screen.findByRole('link', { name: 'Edit playbook' }));
    expect(link.getAttribute('href')).toContain('edit=playbook');
  });

  it('gives a seller no edit controls', async () => {
    servePlaybooks({ scopes: SELLER });
    renderApp('/t/taazaa/playbooks/plb_rfp');
    await screen.findByRole('heading', { name: 'Public sector RFP', level: 1 });
    for (const name of ['Duplicate', 'Retire', 'Delete']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit playbook' })).toBeNull();
  });

  it('writes Unknown offer when the offer is not in the list', async () => {
    servePlaybooks({ playbooks: [rfp({ runs_on: [{ offer_id: 'off_gone', tier: 'watch' }] }), draftPlaybook()] });
    server.use(http.get('/api/v1/offers', () => problem(403, 'No.')));
    renderApp('/t/taazaa/playbooks/plb_rfp');
    const card = await screen.findByRole('region', { name: 'Runs on' });
    await waitFor(() => expect(card).toHaveTextContent('Unknown offer'));
  });
});

describe('Playbook results and What worked (§20)', () => {
  const tileOf = (label: string) => screen.getByText(label, { selector: 'span' }).closest('li')!;

  it('tiles show Finished 5 / Last 90 days, Replied 40% / 2 accounts, Booked a meeting 20% / 1 account, Won 1 / 20% of finished', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    await screen.findByRole('heading', { name: 'Public sector RFP', level: 1 });
    expect(tileOf('Finished')).toHaveTextContent('5Last 90 days');
    expect(tileOf('Replied')).toHaveTextContent('40%2 accounts');
    expect(tileOf('Booked a meeting')).toHaveTextContent('20%1 account');
    expect(tileOf('Booked a meeting')).not.toHaveTextContent('1 accounts');
    expect(tileOf('Won')).toHaveTextContent('120% of finished');
    expect(screen.queryByText('Results appear once accounts have finished the playbook.')).toBeNull();
  });

  it('with nothing finished, tiles show – and Won None yet', async () => {
    servePlaybooks({ playbooks: [rfp({ results: NO_RESULTS })] });
    renderApp('/t/taazaa/playbooks/plb_rfp');
    await screen.findByRole('heading', { name: 'Public sector RFP', level: 1 });
    expect(tileOf('Finished')).toHaveTextContent('0Last 90 days');
    expect(tileOf('Replied')).toHaveTextContent('–');
    expect(tileOf('Booked a meeting')).toHaveTextContent('–');
    expect(tileOf('Won')).toHaveTextContent('None yet');
  });

  it('What worked lists Email then Call with "3" over "1.5 per 10 steps"', async () => {
    servePlaybooks({ whatWorked: WORKED });
    renderApp('/t/taazaa/playbooks/plb_rfp');
    const section = await screen.findByRole('region', { name: 'What worked' });
    await within(section).findByRole('table');
    expect(within(section).getByText('Steps done in the last 90 days and the results they were credited with. A result credits the steps done in the 14 days before it.')).toBeInTheDocument();
    for (const h of ['Step type', 'Steps done', 'Replies', 'Meetings', 'Opportunities', 'Won']) expect(within(section).getByRole('columnheader', { name: h })).toBeInTheDocument();
    const rows = within(section).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Email');
    expect(rows[2]).toHaveTextContent('Call');
    const cells = within(rows[1]!).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('12');
    expect(cells[2]).toHaveTextContent('31.5 per 10 steps');
    expect(cells[3]).toHaveTextContent('10.8 per 10 steps');
  });

  it('under 10 steps the per-10 line is muted with the hidden text', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    const section = await screen.findByRole('region', { name: 'What worked' });
    await within(section).findByRole('table');
    const call = within(section).getByText('Call').closest('tr')!;
    expect(within(call).getAllByText(/too few steps to compare/)).toHaveLength(4);
    expect(within(call).getByText(/2\.5 per 10 steps/).className).toMatch(/muted/);
    const email = within(section).getByText('Email').closest('tr')!;
    expect(within(email).queryByText(/too few steps to compare/)).toBeNull();
  });

  it('No recent step row shows counts', async () => {
    servePlaybooks();
    renderApp('/t/taazaa/playbooks/plb_rfp');
    const section = await screen.findByRole('region', { name: 'What worked' });
    const row = (await within(section).findByText('No recent step')).closest('tr')!;
    const cells = within(row).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent(/^2$/);
    expect(cells[5]).toHaveTextContent(/^1$/);
    expect(row).not.toHaveTextContent('per 10 steps');
  });

  it('empty state copy', async () => {
    servePlaybooks({ whatWorked: WORKED_NONE });
    renderApp('/t/taazaa/playbooks/plb_rfp');
    const section = await screen.findByRole('region', { name: 'What worked' });
    expect(await within(section).findByText('No steps done in the last 90 days.')).toBeInTheDocument();
    expect(within(section).queryByRole('table')).toBeNull();
  });

  it('the section is hidden without analytics:read', async () => {
    servePlaybooks({ scopes: SELLER });
    renderApp('/t/taazaa/playbooks/plb_rfp');
    await screen.findByRole('heading', { name: 'Public sector RFP', level: 1 });
    expect(screen.queryByRole('region', { name: 'What worked' })).toBeNull();
    expect(screen.queryByText('What worked')).toBeNull();
  });
});
