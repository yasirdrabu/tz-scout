import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { BRIEF, SELLER, serveAccount } from './testing';

const brief = () => screen.findByRole('region', { name: 'Brief' });
const section = async (title: string) => within(await brief()).findByRole('region', { name: title });

beforeEach(() => localStorage.clear());

describe('Brief', () => {
  it('shows when it was drafted and each section with who wrote it', async () => {
    serveAccount();
    renderApp('/t/taazaa/accounts/acc_mdc');
    expect(await within(await brief()).findByText(/^Last drafted Oct 24/)).toBeInTheDocument();
    expect(await section('Overview')).toHaveTextContent('Written by Claude');
    expect(await section('Overview')).toHaveTextContent('Miami-Dade County runs the transit system.');
    expect(await section('Approach')).toHaveTextContent('Edited by Dana Ruiz');
    expect(await section('Value angle')).toHaveTextContent('Assembled from rules');
    expect(await section('Risks')).toHaveTextContent('Written by Claude');
  });

  it('edits a section: the PUT carries if_version, the toast names it and the tag becomes the API label', async () => {
    serveAccount();
    let body: unknown = null;
    server.use(
      http.put('/api/v1/accounts/acc_mdc/brief/sections/overview', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          ...BRIEF.sections[0],
          body: 'They run buses and rail.',
          written_by: 'person',
          label: 'Edited by Zach Wiant',
          edited_by_name: 'Zach Wiant',
          version: 3,
        });
      }),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const overview = await section('Overview');
    await userEvent.click(within(overview).getByRole('button', { name: 'Edit Overview' }));
    const box = within(overview).getByRole('textbox', { name: 'Overview' });
    expect(box).toHaveAccessibleDescription('Saving marks this section as edited by you.');
    await userEvent.clear(box);
    await userEvent.type(box, 'They run buses and rail.');
    await userEvent.click(within(overview).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Overview saved')).toBeInTheDocument();
    expect(body).toEqual({ body: 'They run buses and rail.', if_version: 2 });
    expect(await within(overview).findByText('Edited by Zach Wiant')).toBeInTheDocument();
    expect(overview).toHaveTextContent('They run buses and rail.');
    expect(within(overview).queryByRole('textbox')).toBeNull();
  });

  it('Cancel leaves the section as it was', async () => {
    serveAccount();
    renderApp('/t/taazaa/accounts/acc_mdc');
    const risks = await section('Risks');
    await userEvent.click(within(risks).getByRole('button', { name: 'Edit Risks' }));
    await userEvent.type(within(risks).getByRole('textbox', { name: 'Risks' }), ' more');
    await userEvent.click(within(risks).getByRole('button', { name: 'Cancel' }));
    expect(risks).toHaveTextContent('Risks text.');
    expect(within(risks).queryByRole('textbox')).toBeNull();
  });

  it('a 409 shows the API title and keeps the text', async () => {
    serveAccount();
    server.use(http.put('/api/v1/accounts/acc_mdc/brief/sections/overview', () => problem(409, 'Someone changed this section since you opened it. Reload to see their version.')));
    renderApp('/t/taazaa/accounts/acc_mdc');
    const overview = await section('Overview');
    await userEvent.click(within(overview).getByRole('button', { name: 'Edit Overview' }));
    await userEvent.type(within(overview).getByRole('textbox', { name: 'Overview' }), ' Mine.');
    await userEvent.click(within(overview).getByRole('button', { name: 'Save' }));
    expect(await within(overview).findByRole('alert')).toHaveTextContent('Someone changed this section since you opened it. Reload to see their version.');
    expect(within(overview).getByRole('textbox', { name: 'Overview' })).toHaveValue('Miami-Dade County runs the transit system. It has 3,800 staff. Mine.');
  });

  it('hides Edit and Redraft without playbooks:write', async () => {
    serveAccount({ scopes: SELLER.filter((s) => s !== 'playbooks:write') });
    renderApp('/t/taazaa/accounts/acc_mdc');
    const approach = await section('Approach');
    expect(approach).toHaveTextContent('Written for AI Opportunity Map');
    expect(within(await brief()).queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(within(approach).queryByRole('button', { name: 'Redraft Approach' })).toBeNull();
  });

  it('Written for {offer} with Redraft asks first, then posts include_edited and shows the drafting line', async () => {
    serveAccount();
    let body: unknown = null;
    let drafting = false;
    server.use(
      http.post(exactly('/api/v1/accounts/acc_mdc:draft-brief'), async ({ request }) => {
        body = await request.json();
        drafting = true;
        return HttpResponse.json({ state: 'drafting' }, { status: 202 });
      }),
      http.get('/api/v1/accounts/acc_mdc/brief', () => HttpResponse.json({ ...BRIEF, state: drafting ? 'drafting' : 'ready' })),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const approach = await section('Approach');
    expect(approach).toHaveTextContent('Written for AI Opportunity Map');
    await userEvent.click(within(approach).getByRole('button', { name: 'Redraft Approach' }));
    const confirm = await screen.findByRole('dialog', { name: 'Redraft Approach?' });
    expect(confirm).toHaveTextContent('Scout rewrites this section for Modernization Blueprint. Your edited version stays in the history.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Redraft' }));
    await waitFor(() => expect(body).toEqual({ include_edited: ['approach'] }));
    expect(await within(await brief()).findByText('Scout is redrafting this brief')).toBeInTheDocument();
  });

  it('a failed redraft shows the API words', async () => {
    serveAccount();
    server.use(http.post(exactly('/api/v1/accounts/acc_mdc:draft-brief'), () => problem(403, 'Forbidden', { detail: "You don't have access to that." })));
    renderApp('/t/taazaa/accounts/acc_mdc');
    await userEvent.click(within(await section('Approach')).getByRole('button', { name: 'Redraft Approach' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Redraft Approach?' })).getByRole('button', { name: 'Redraft' }));
    expect(await screen.findByText("You don't have access to that.")).toBeInTheDocument();
  });

  it('says the brief did not load, and loads it on Try again', async () => {
    serveAccount();
    let calls = 0;
    server.use(
      http.get('/api/v1/accounts/acc_mdc/brief', () => {
        calls += 1;
        return calls === 1 ? problem(500, 'Scout could not read the brief.') : HttpResponse.json(BRIEF);
      }),
    );
    renderApp('/t/taazaa/accounts/acc_mdc');
    const card = await brief();
    expect(await within(card).findByRole('alert')).toHaveTextContent("The brief didn't load. Scout could not read the brief.");
    await userEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(await within(card).findByText('Miami-Dade County runs the transit system. It has 3,800 staff.')).toBeInTheDocument();
  });
});
