import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { problem } from '../../../test/http';
import { renderApp, serveMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { AiRunDetail } from '../../admin/ai-runs/api';
import type { WorkspaceRun, TaskTotal } from './api';

const run = (r: Partial<WorkspaceRun> & Pick<WorkspaceRun, 'id'>): WorkspaceRun => ({
  tenant_id: 'taazaa',
  task: 'arrival_normalise',
  prompt_version: 'v3',
  mode: 'live',
  model: 'claude-sonnet-4-5',
  status: 'succeeded',
  outcome: 'ok',
  subject: { type: 'account', id: 'acc_miami' },
  input_tokens: 18_400,
  output_tokens: 1_200,
  cache_read_tokens: 0,
  cost_cents: 7,
  duration_ms: 6_200,
  created_at: '2026-10-31T14:02:00Z',
  ...r,
});

const RUNS = [
  run({ id: 'run_8f21' }),
  run({ id: 'run_8f1c', status: 'failed', outcome: 'invalid_output', task: 'csv_column_mapping', model: null, subject: null }),
];

const TOTALS: TaskTotal[] = [
  { task: 'arrival_normalise', runs: 412, input_tokens: 7_100_000, output_tokens: 480_000, cost_cents: 2_960 },
  { task: 'csv_column_mapping', runs: 9, input_tokens: 41_000, output_tokens: 3_000, cost_cents: 30 },
];

let seen: URLSearchParams[] = [];

function serve(runs = RUNS, scopes = ['settings:manage']) {
  seen = [];
  serveMe({ taazaa: { scopes } });
  server.use(
    http.get('/api/v1/ai-runs', ({ request }) => {
      seen.push(new URL(request.url).searchParams);
      return HttpResponse.json({ data: runs, totals: runs.length ? TOTALS : [] });
    }),
  );
}

beforeEach(() => localStorage.clear());

describe('Settings > AI runs', () => {
  it("lists this workspace's runs without a tenant column, and this month's totals per task", async () => {
    serve();
    renderApp('/t/taazaa/settings/ai-runs');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'AI runs' })).toHaveAttribute('aria-current', 'page');
    const tables = await screen.findAllByRole('table');
    const runs = tables.find((t) => within(t).queryByRole('columnheader', { name: 'Run' }))!;
    expect(within(runs).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Run', 'Status', 'Task and account', 'Model', 'Tokens', 'Cost', 'Time', 'When']);
    const failed = within(runs).getByRole('button', { name: /run_8f1c/ }).closest('tr')!;
    expect(failed).toHaveTextContent('Failed');
    expect(failed).toHaveTextContent('Answer rejected');
    expect(failed).toHaveTextContent('Rules, no model');
    expect(within(runs).getByRole('button', { name: /run_8f21/ }).closest('tr')).toHaveTextContent('claude-sonnet-4-5');
    const month = screen.getByRole('table', { name: 'This month' });
    const row = within(month).getByText('Arrival normalise').closest('tr')!;
    expect(row).toHaveTextContent('412');
    expect(row).toHaveTextContent('$29.60');
    expect(screen.getByText('Showing 2 runs, newest first')).toBeInTheDocument();
  });

  it('is a tab for settings:manage only', async () => {
    serveMe({ taazaa: { scopes: ['members:read'] } });
    renderApp('/t/taazaa/settings/ai-runs');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(nav).queryByRole('link', { name: 'AI runs' })).toBeNull();
    expect(screen.getByRole('heading', { name: "This tab isn't open to you" })).toBeInTheDocument();
  });

  it('filters by status and task, in the URL', async () => {
    serve();
    const app = renderApp('/t/taazaa/settings/ai-runs');
    await screen.findByRole('button', { name: /run_8f1c/ });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'failed');
    await waitFor(() => expect(app.router.state.location.search).toEqual({ status: 'failed' }));
    await waitFor(() => expect(seen.at(-1)?.get('status')).toBe('failed'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Task' }), 'csv_column_mapping');
    await waitFor(() => expect(seen.at(-1)?.get('task')).toBe('csv_column_mapping'));
    expect(app.router.state.location.search).toEqual({ status: 'failed', task: 'csv_column_mapping' });
  });

  it('shows the empty state', async () => {
    serve([]);
    renderApp('/t/taazaa/settings/ai-runs');
    expect(await screen.findByRole('heading', { name: 'No AI runs yet' })).toBeInTheDocument();
  });

  it('shows the loading line', async () => {
    serve();
    server.use(
      http.get('/api/v1/ai-runs', async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    renderApp('/t/taazaa/settings/ai-runs');
    expect(await screen.findByText('Loading AI runs')).toBeInTheDocument();
  });

  it('says what failed, with Try again', async () => {
    serve();
    server.use(http.get('/api/v1/ai-runs', () => problem(500, 'Something went wrong', { detail: 'The database is down.', ref: 'cor_r1' })));
    renderApp('/t/taazaa/settings/ai-runs');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("AI runs didn't load");
    expect(alert).toHaveTextContent('The database is down.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('expands a run from this workspace, and keeps it open in the URL', async () => {
    serve();
    const detail: AiRunDetail = { ...RUNS[1]!, tenant_name: null, input_hash: 'sha256:ab12', output: { columns: 4 }, error: 'The answer had no columns.' };
    let asked: string | null = null;
    server.use(
      http.get('/api/v1/ai-runs/run_8f1c', ({ request }) => {
        asked = request.headers.get('x-scout-tenant');
        return HttpResponse.json(detail);
      }),
    );
    const app = renderApp('/t/taazaa/settings/ai-runs');
    const toggle = await screen.findByRole('button', { name: /run_8f1c/ });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('sha256:ab12')).toBeInTheDocument();
    expect(screen.getByText('The answer had no columns.')).toBeInTheDocument();
    expect(asked).toBe('taazaa');
    expect(app.router.state.location.search).toEqual({ open: 'run_8f1c' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
