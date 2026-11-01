import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { exactly, multipartFields, problem } from '../../test/http';
import { renderApp } from '../../test/renderApp';
import { server } from '../../test/server';
import { APTA, detail, IMPORT, serveBatches } from './testing';

const params = (href: string) => new URL(href, 'http://x').searchParams;
const csv = () => new File(['Org Name,URL\nAcme,acme.org\n'], 'list.csv', { type: 'text/csv' });

/** POST /imports answered with `answer`; returns the multipart fields of each upload. */
function serveUpload(answer: () => Response) {
  const uploads: Record<string, string>[] = [];
  server.use(
    http.post('/api/v1/imports', async ({ request }) => {
      uploads.push(await multipartFields(request));
      return answer();
    }),
  );
  return uploads;
}

const created = (status: 'needs_confirm' | 'queued') => () => HttpResponse.json({ import_id: 'imp_1', batch_id: 'bat_1044', status, needs_confirm: status === 'needs_confirm' }, { status: 202 });

function serveImport(view = IMPORT, preview = { total: 64, without_website: 7, go_ahead: 57 }) {
  const seen: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.get('/api/v1/imports/:id', () => HttpResponse.json(view)),
    http.post(exactly('/api/v1/imports/imp_1:preview'), async ({ request }) => {
      seen.push({ method: 'POST', path: 'preview', body: await request.json() });
      return HttpResponse.json(preview);
    }),
    http.post(exactly('/api/v1/imports/imp_1:confirm'), async ({ request }) => {
      seen.push({ method: 'POST', path: 'confirm', body: await request.json() });
      return HttpResponse.json({ import_id: 'imp_1', status: 'queued' }, { status: 202 });
    }),
    http.delete('/api/v1/imports/:id', () => {
      seen.push({ method: 'DELETE', path: 'imp_1', body: null });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return seen;
}

describe('Import a list: Upload (§15)', () => {
  it('lets someone who manages sources pick the source, preselected from the URL, and sends it with the notes', async () => {
    serveBatches();
    serveImport();
    const uploads = serveUpload(created('needs_confirm'));
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/batches/import?source=src_csv');
    expect(await screen.findByText('Drop a CSV, Excel or Markdown file here')).toBeInTheDocument();
    expect(screen.getByText('Or click to choose one. Up to 10,000 rows and 20 MB. One company per row.')).toBeInTheDocument();
    const select = await screen.findByRole('combobox', { name: 'Source' });
    await waitFor(() => expect(select).toHaveValue('src_csv'));
    expect(within(select).getByRole('option', { name: 'Kestrel Advisory (Partner)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeInTheDocument();
    await user.upload(screen.getByLabelText('File to import'), csv());
    await user.type(screen.getByRole('textbox', { name: 'Batch notes' }), 'APTA 2026 attendee list');
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(params(app.path()).get('step')).toBe('match'));
    expect(params(app.path()).get('import')).toBe('imp_1');
    expect(uploads[0]).toEqual({ file: 'list.csv', source_id: 'src_csv', notes: 'APTA 2026 attendee list' });
  });

  it("shows the person's own source read only without sources:manage, and sends no source", async () => {
    serveBatches({ scopes: ['arrivals:read', 'imports:run'] });
    serveImport();
    const uploads = serveUpload(created('needs_confirm'));
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/import');
    expect(await screen.findByText('Marcus Lee')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
    await user.upload(screen.getByLabelText('File to import'), csv());
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]).toEqual({ file: 'list.csv' });
  });

  it('asks which sheet of a workbook to import, then sends it again with that sheet', async () => {
    serveBatches();
    serveImport();
    let n = 0;
    const uploads = serveUpload(() => (n++ === 0 ? HttpResponse.json({ status: 'needs_sheet', sheets: ['Leads', 'Notes'] }) : created('needs_confirm')()));
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/batches/import');
    await user.upload(await screen.findByLabelText('File to import'), csv());
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('Pick the sheet to import')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leads' }));
    await waitFor(() => expect(params(app.path()).get('step')).toBe('match'));
    expect(uploads[1]).toMatchObject({ file: 'list.csv', sheet: 'Leads' });
  });

  it('goes straight to Resolve for a layout Scout knows', async () => {
    serveBatches();
    serveImport({ ...IMPORT, status: 'queued' });
    serveUpload(created('queued'));
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/batches/import');
    await user.upload(await screen.findByLabelText('File to import'), csv());
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(params(app.path()).get('step')).toBe('resolve'));
  });

  it('shows the API words for a file it refuses, and the 413 copy', async () => {
    serveBatches();
    let status = 400;
    serveUpload(() => (status === 400 ? problem(400, 'This file has more than 10,000 rows. Split it and import the parts.') : problem(413, 'This request is over the size limit.')));
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/import');
    await user.upload(await screen.findByLabelText('File to import'), csv());
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('This file has more than 10,000 rows. Split it and import the parts.')).toBeInTheDocument();
    status = 413;
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('This file is over 20 MB. Split it and import the parts.')).toBeInTheDocument();
  });
});

describe('Import a list: Match columns', () => {
  it('shows the file card, the suggestion line, the first three samples and the tags', async () => {
    serveBatches();
    serveImport();
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/import?step=match&import=imp_1');
    expect(await screen.findByText('Excel apta-2026-attendees.xlsx, 64 rows · Sheet 1 · uploaded by Marcus Lee')).toBeInTheDocument();
    expect(screen.getByText('Scout suggested 2 of 3. Check them, then confirm.')).toBeInTheDocument();
    expect(screen.getByText('Port Authority of Savannah, Lakeshore Regional Transit, Metro Bayfront Rail')).toBeInTheDocument();
    expect(screen.queryByText(/Never shown/)).toBeNull();
    const badge = screen.getByRole('combobox', { name: 'Scout field for Badge ID' });
    expect(badge).toHaveValue('');
    expect(within(badge.closest('tr')!).getByText('No match. Check this one')).toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: 'Scout field for URL' }).closest('tr')!).getByText('Suggested')).toBeInTheDocument();
    await user.selectOptions(badge, 'Notes');
    expect(within(badge.closest('tr')!).getByText('Changed by you')).toBeInTheDocument();
  });

  it('Use a different file discards the upload and goes back to Upload', async () => {
    serveBatches();
    const seen = serveImport();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/batches/import?step=match&import=imp_1');
    await user.click(await screen.findByRole('button', { name: 'Use a different file' }));
    await waitFor(() => expect(params(app.path()).get('step')).toBeNull());
    expect(params(app.path()).get('import')).toBeNull();
    expect(seen.some((s) => s.method === 'DELETE')).toBe(true);
  });
});

describe('Import a list: Confirm', () => {
  it('says how many rows are held, then imports with the mapping as changed', async () => {
    serveBatches();
    const seen = serveImport();
    const user = userEvent.setup();
    const app = renderApp('/t/taazaa/batches/import?step=match&import=imp_1');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Scout field for Badge ID' }), 'Notes');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('7 rows have no website')).toBeInTheDocument();
    expect(screen.getByText("They'll be held in the batch until you add one. The other 57 rows go ahead now. You can add websites here or later from the batch.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import 57 rows and hold 7' }));
    await waitFor(() => expect(params(app.path()).get('step')).toBe('resolve'));
    const confirm = seen.find((s) => s.path === 'confirm')!.body as { mapping: { header: string; target: string | null }[] };
    expect(confirm.mapping.find((c) => c.header === 'Badge ID')?.target).toBe('account.notes');
  });

  it('says it for one row, and leaves the callout out when every row has a website', async () => {
    serveBatches();
    serveImport(IMPORT, { total: 64, without_website: 1, go_ahead: 63 });
    const one = renderApp('/t/taazaa/batches/import?step=confirm&import=imp_1');
    expect(await screen.findByText('1 row has no website')).toBeInTheDocument();
    expect(screen.getByText(/^It'll be held in the batch until you add one\. The other 63 rows go ahead now\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 63 rows and hold 1' })).toBeInTheDocument();
    one.unmount();
    serveImport(IMPORT, { total: 64, without_website: 0, go_ahead: 64 });
    renderApp('/t/taazaa/batches/import?step=confirm&import=imp_1');
    expect(await screen.findByRole('button', { name: 'Import 64 rows' })).toBeInTheDocument();
    expect(screen.queryByText(/no website/)).toBeNull();
  });

  it('shows a mapping error from the API', async () => {
    serveBatches();
    serveImport();
    server.use(http.post(exactly('/api/v1/imports/imp_1:confirm'), () => problem(400, 'Map a column to the company name, website or domain.')));
    const user = userEvent.setup();
    renderApp('/t/taazaa/batches/import?step=confirm&import=imp_1');
    await user.click(await screen.findByRole('button', { name: 'Import 57 rows and hold 7' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Map a column to the company name, website or domain.');
  });
});

describe('Import a list: Resolve', () => {
  it('polls the import and the batch every 2 s and stops once it is done', async () => {
    serveBatches();
    let importCalls = 0;
    let batchCalls = 0;
    server.use(
      http.get('/api/v1/imports/:id', () => {
        importCalls++;
        return HttpResponse.json({ ...IMPORT, status: importCalls < 2 ? 'queued' : 'imported' });
      }),
      http.get('/api/v1/batches/:id', () => {
        batchCalls++;
        return HttpResponse.json(batchCalls < 2 ? detail({ ...APTA, status_key: 'in_progress', status_label: 'In progress' }) : detail(APTA));
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp('/t/taazaa/batches/import?step=resolve&import=imp_1');
      expect(await screen.findByText('Batch bat_1044 created')).toBeInTheDocument();
      expect(screen.getByText('Matching companies and checking for duplicates')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(await screen.findByText('Done. 51 accounts resolved. 7 rows need you.')).toBeInTheDocument();
      expect(screen.getByText('44 are in the review queue.')).toBeInTheDocument();
      expect(screen.getByText('APTA 2026 attendee list · 64 accounts')).toBeInTheDocument();
      expect(screen.getByText('51 resolved, 6 rejected, 7 waiting')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open the 7 waiting rows' }).getAttribute('href')).toBe('/t/taazaa/batches/bat_1044?tab=waiting');
      expect(screen.getByRole('link', { name: 'Go to review queue' })).toBeInTheDocument();
      const settled = { importCalls, batchCalls };
      await vi.advanceTimersByTimeAsync(6_000);
      expect({ importCalls, batchCalls }).toEqual(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves out the queue line and button without review:act', async () => {
    serveBatches({ scopes: ['arrivals:read', 'imports:run'], one: detail(APTA, { in_queue: null }) });
    server.use(http.get('/api/v1/imports/:id', () => HttpResponse.json({ ...IMPORT, status: 'imported' })));
    renderApp('/t/taazaa/batches/import?step=resolve&import=imp_1');
    expect(await screen.findByText('Done. 51 accounts resolved. 7 rows need you.')).toBeInTheDocument();
    expect(screen.queryByText(/in the review queue/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Go to review queue' })).toBeNull();
  });
});
