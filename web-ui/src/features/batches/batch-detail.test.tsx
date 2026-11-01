import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { APTA, detail, serveBatches } from './testing';

const params = (href: string) => new URL(href, 'http://x').searchParams;

describe('Batch detail (§14)', () => {
  it('shows the breadcrumb, the notes as title, the sub line and the summary from the API', async () => {
    serveBatches();
    renderApp('/t/taazaa/batches/bat_1044');
    expect(await screen.findByRole('heading', { name: 'APTA 2026 attendee list' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Batches' })).toBeInTheDocument();
    expect(within(crumbs).getByText('bat_1044')).toBeInTheDocument();
    expect(screen.getByText(/^CSV imports · Marcus Lee · Run .* · apta-2026-attendees\.xlsx$/)).toBeInTheDocument();
    const summary = screen.getByRole('list', { name: 'Batch summary' });
    expect(within(summary).getByText('51 resolved')).toBeInTheDocument();
    expect(within(summary).getByText('6 rejected')).toBeInTheDocument();
    expect(within(summary).getByText('7 waiting on you')).toBeInTheDocument();
    expect(within(summary).getByText('44 in the review queue')).toBeInTheDocument();
    expect(screen.getByText('Rows still waiting after 30 days are rejected.')).toBeInTheDocument();
  });

  it('counts the tabs from the stages and keeps the tab in the URL', async () => {
    const seen = serveBatches();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/batches/bat_1044');
    expect(await screen.findByRole('tab', { name: 'All 64' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Resolved 51' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Rejected 6' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Waiting 7' }));
    await waitFor(() => expect(params(app.path()).get('tab')).toBe('waiting'));
    await waitFor(() => expect(seen.some((s) => s.url.pathname.endsWith('/items') && s.url.searchParams.get('status') === 'waiting')).toBe(true));
  });

  it('shows the outcome words and links an account the caller can see', async () => {
    serveBatches();
    renderApp('/t/taazaa/batches/bat_1044');
    expect(await screen.findByRole('link', { name: 'Port Authority of Savannah' })).toBeInTheDocument();
    expect(screen.getByText('Resolved: New account')).toBeInTheDocument();
    expect(screen.getByText('Rejected: Duplicate of another row in this batch')).toBeInTheDocument();
    expect(screen.getByText('Waiting: Possible duplicate')).toBeInTheDocument();
  });

  it('resolves a row that needs a website, and asks for one first when it is empty', async () => {
    const seen = serveBatches();
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/bat_1044?tab=waiting');
    const input = await screen.findByRole('textbox', { name: 'Website for Lakeshore Regional Transit' });
    const form = input.closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Resolve' }));
    expect(await within(form).findByText('Add a website first, like lakeshoreregionaltransit.org')).toBeInTheDocument();
    await user.type(input, 'lakeshoretransit.org');
    await user.click(within(form).getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByText('Lakeshore Regional Transit resolved.')).toBeInTheDocument();
    expect(seen.find((s) => s.url.pathname === '/api/v1/arrivals/arr_2:supply-website')?.body).toEqual({ website: 'lakeshoretransit.org' });
  });

  it('shows the API error under the row form', async () => {
    serveBatches();
    server.use(http.post(/\/api\/v1\/arrivals\/arr_2:supply-website$/, () => problem(400, 'Enter a website address like acme.com.')));
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/bat_1044?tab=waiting');
    const input = await screen.findByRole('textbox', { name: 'Website for Lakeshore Regional Transit' });
    await user.type(input, 'nope');
    await user.click(within(input.closest('form')!).getByRole('button', { name: 'Resolve' }));
    expect(await within(input.closest('form')!).findByText('Enter a website address like acme.com.')).toBeInTheDocument();
  });

  it('supplies a company, or says it is a sole proprietor with the person\'s name', async () => {
    const seen = serveBatches();
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/bat_1044?tab=waiting');
    const name = await screen.findByRole('textbox', { name: 'Company name' });
    await user.type(name, 'Tri-County Paratransit');
    await user.click(within(name.closest('form')!).getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByText('Tri-County Paratransit resolved.')).toBeInTheDocument();
    expect(seen.find((s) => s.url.pathname === '/api/v1/arrivals/arr_3:supply-company')?.body).toEqual({ name: 'Tri-County Paratransit' });

    await user.click(screen.getByRole('checkbox', { name: 'This is a sole proprietor' }));
    await user.type(screen.getByRole('textbox', { name: "Person's name" }), 'Dana Kim');
    await user.click(within(screen.getByRole('textbox', { name: "Person's name" }).closest('form')!).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(seen.filter((s) => s.url.pathname === '/api/v1/arrivals/arr_3:supply-company').at(-1)?.body).toEqual({ sole_proprietor: true, person_name: 'Dana Kim' }));
  });

  it('chooses the same company or a new one for a possible duplicate', async () => {
    const seen = serveBatches();
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/bat_1044?tab=waiting');
    await user.click(await screen.findByRole('button', { name: 'Same company as Rio Verde Transit District' }));
    expect(await screen.findByText('Rio Verde Transit resolved.')).toBeInTheDocument();
    expect(seen.find((s) => s.url.pathname === '/api/v1/arrivals/arr_4:choose')?.body).toEqual({ same_as: 'acc_rio' });
    await user.click(screen.getByRole('button', { name: "It's a new company" }));
    await waitFor(() => expect(seen.filter((s) => s.url.pathname === '/api/v1/arrivals/arr_4:choose').at(-1)?.body).toEqual({ new_company: true }));
  });

  it('skips the waiting rows after the confirm', async () => {
    const seen = serveBatches();
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/bat_1044');
    await user.click(await screen.findByRole('button', { name: 'Skip the waiting rows' }));
    const dialog = await screen.findByRole('dialog', { name: 'Skip 7 waiting rows?' });
    expect(within(dialog).getByText("They're rejected and won't reach review.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Skip the waiting rows' }));
    expect(await screen.findByText('Skipped 3 rows.')).toBeInTheDocument();
    expect(seen.some((s) => s.method === 'POST' && s.url.pathname === '/api/v1/batches/bat_1044:skip-waiting')).toBe(true);
  });

  it('downloads the original file', async () => {
    serveBatches();
    let asked = '';
    server.use(
      http.get('/api/v1/batches/:id/files/:fileId', ({ request }) => {
        asked = new URL(request.url).pathname;
        return new HttpResponse('x', { headers: { 'content-type': 'application/octet-stream' } });
      }),
    );
    const created = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/bat_1044');
    await user.click(await screen.findByRole('button', { name: 'Download file' }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(asked).toBe('/api/v1/batches/bat_1044/files/fil_apta');
  });

  it('leaves out the queue count without review:act, and the forms without imports:run', async () => {
    serveBatches({ scopes: ['arrivals:read'], one: detail(APTA, { in_queue: null }) });
    renderApp('/t/taazaa/batches/bat_1044?tab=waiting');
    expect(await screen.findByText('Waiting: Needs a website')).toBeInTheDocument();
    expect(screen.queryByText(/in the review queue/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip the waiting rows' })).toBeNull();
  });
});
