import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { formatDateTime } from '../../../lib/format';
import { problem } from '../../../test/http';
import { renderApp, serveNoTenantMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import type { AiRun, AiRunDetail, RunsSummary } from './api';

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const run = (r: Partial<AiRun> & Pick<AiRun, 'id'>): AiRun => ({
  tenant_id: 't_taazaa',
  tenant_name: 'Taazaa',
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

const PAGE_1 = [
  run({ id: 'run_8f21' }),
  run({ id: 'run_8f1c', status: 'failed', outcome: 'invalid_output', task: 'csv_column_mapping', tenant_id: 't_harbor', tenant_name: 'Harbor Health Partners', duration_ms: 61_000, model: null, subject: null }),
];
const PAGE_2 = [run({ id: 'run_8e02', status: 'stopped_by_limit', outcome: 'refused_by_cap' })];

const SUMMARY: RunsSummary = { runs_today: 1284, failed_pct: 1.9, median_ms: 6200, slowest_task: 'csv_column_mapping', spend_today_cents: 4180, failed_last_hour: 3 };

let seen: URLSearchParams[] = [];

function serve(summary: RunsSummary = SUMMARY) {
  seen = [];
  serveNoTenantMe();
  server.use(
    http.get('/v1/admin/ai-runs', ({ request }) => {
      const p = new URL(request.url).searchParams;
      seen.push(p);
      if (p.get('q') === 'nothing') return HttpResponse.json({ data: [], next_cursor: null, summary });
      if (p.get('cursor') === 'opaque-c2') return HttpResponse.json({ data: PAGE_2, next_cursor: null, summary });
      return HttpResponse.json({ data: PAGE_1, next_cursor: 'opaque-c2', summary });
    }),
    http.get('/v1/admin/tenants', () =>
      HttpResponse.json({
        data: [
          { id: 't_taazaa', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York', status: 'active', created_at: '2026-01-01T00:00:00Z', member_count: 14, owner: null },
          { id: 't_harbor', slug: 'harbor', name: 'Harbor Health Partners', currency: 'USD', timezone: 'America/New_York', status: 'active', created_at: '2026-01-01T00:00:00Z', member_count: 22, owner: null },
        ],
        summary: { active: 2, suspended: 0 },
      }),
    ),
  );
}

const last = () => seen[seen.length - 1]!;

beforeEach(() => localStorage.clear());

describe('AI runs', () => {
  it('shows the tiles for today and the runs, and pages with Show more', async () => {
    serve();
    renderApp('/admin/ai-runs');
    expect(await screen.findByRole('heading', { level: 1, name: 'AI runs' })).toBeInTheDocument();
    expect(screen.getByText('Every call Scout makes to the model: briefs, scores, fact checks and email drafts.')).toBeInTheDocument();
    expect(await screen.findByText('1,284')).toBeInTheDocument();
    expect(screen.getByText('1.9%')).toBeInTheDocument();
    expect(screen.getByText('Target under 3%')).toBeInTheDocument();
    expect(screen.getByText('Slowest task: Csv column mapping')).toBeInTheDocument();
    expect(screen.getByText('$41.80')).toBeInTheDocument();

    const ok = screen.getByRole('button', { name: 'run_8f21' }).closest('tr')!;
    expect(ok).toHaveTextContent('Succeeded');
    expect(ok).toHaveTextContent('Arrival normalise');
    expect(ok).toHaveTextContent('account acc_miami');
    expect(ok).toHaveTextContent('Taazaa');
    expect(ok).toHaveTextContent('claude-sonnet-4-5');
    expect(ok).toHaveTextContent('18.4K in · 1.2K out');
    expect(ok).toHaveTextContent('$0.07');
    expect(ok).toHaveTextContent('6.2 s');
    expect(ok).toHaveTextContent(formatDateTime('2026-10-31T14:02:00Z', zone));

    const failed = screen.getByRole('button', { name: 'run_8f1c' }).closest('tr')!;
    expect(failed).toHaveTextContent('Failed');
    expect(failed).toHaveTextContent('Answer rejected');
    expect(failed).toHaveTextContent('Harbor Health Partners');
    expect(failed).toHaveTextContent('Rules, no model');
    expect(within(failed).getByText('1 min')).toHaveClass('bad');

    expect(screen.getByText('Showing 2 runs, newest first')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: 'run_8e02' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'run_8e02' }).closest('tr')).toHaveTextContent('Stopped by limit');
    expect(last().get('cursor')).toBe('opaque-c2');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('searches and filters by status, task and tenant', async () => {
    serve();
    renderApp('/admin/ai-runs');
    await screen.findByRole('button', { name: 'run_8f21' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Stopped by limit');
    await waitFor(() => expect(last().get('status')).toBe('stopped_by_limit'));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Task' }), 'Csv column mapping');
    await waitFor(() => expect(last().get('task')).toBe('csv_column_mapping'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Tenant' }), 'Harbor Health Partners');
    await waitFor(() => expect(last().get('tenant')).toBe('t_harbor'));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find by run, account or task' }), 'nothing');
    expect(await screen.findByRole('heading', { name: 'No runs match' })).toBeInTheDocument();
    expect(last().get('q')).toBe('nothing');
    expect(screen.getByText('Try other words, or another status, task or tenant.')).toBeInTheDocument();
  });

  it('shows the failed in the last hour banner, and Show them filters to failed runs', async () => {
    serve();
    renderApp('/admin/ai-runs');
    expect(await screen.findByText('3 failed in the last hour')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(last().get('status')).toBe('failed'));
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('failed');
  });

  it('shows no banner and empty tiles on a quiet day', async () => {
    serve({ runs_today: 0, failed_pct: null, median_ms: null, slowest_task: null, spend_today_cents: 0, failed_last_hour: 0 });
    renderApp('/admin/ai-runs');
    expect(await screen.findByText('No runs today')).toBeInTheDocument();
    expect(screen.queryByText(/failed in the last hour/)).toBeNull();
  });

  it('shows loading and error states', async () => {
    serveNoTenantMe();
    server.use(
      http.get('/v1/admin/tenants', () => HttpResponse.json({ data: [], summary: { active: 0, suspended: 0 } })),
      http.get('/v1/admin/ai-runs', async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    const first = renderApp('/admin/ai-runs');
    expect(await screen.findByText('Loading AI runs')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('/v1/admin/ai-runs', () => problem(400, 'Check the request.', { detail: 'That cursor is not valid.', ref: 'cor_a1' })));
    renderApp('/admin/ai-runs');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("AI runs didn't load");
    expect(alert).toHaveTextContent('That cursor is not valid.');
    expect(within(alert).getByText('Error ref cor_a1')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('expanded run', () => {
  const DETAIL: AiRunDetail = {
    ...PAGE_1[1]!,
    subject: { type: 'import', id: 'imp_1044' },
    input_hash: 'sha256:9f2c1a',
    output: { columns: { Company: 'name' } },
    error: "Output didn't match the schema: no recipient.",
  };

  it('opens with the keyboard and shows what was sent, what came back and the error', async () => {
    serve();
    server.use(http.get('/v1/admin/ai-runs/run_8f1c', () => HttpResponse.json(DETAIL)));
    renderApp('/admin/ai-runs');
    const toggle = await screen.findByRole('button', { name: 'run_8f1c' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const sent = await screen.findByRole('region', { name: 'What Scout sent' });
    expect(sent).toHaveTextContent('import imp_1044');
    expect(sent).toHaveTextContent('sha256:9f2c1a');
    expect(sent).toHaveTextContent("Scout doesn't keep the input itself.");
    expect(screen.getByRole('region', { name: 'What came back' })).toHaveTextContent('"Company": "name"');
    expect(screen.getByRole('region', { name: 'Error' })).toHaveTextContent("Output didn't match the schema: no recipient.");

    await userEvent.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'What Scout sent' })).toBeNull();
  });

  it('says when nothing came back, and shows a failed load', async () => {
    serve();
    server.use(http.get('/v1/admin/ai-runs/run_8f21', () => HttpResponse.json({ ...PAGE_1[0], input_hash: null, output: null, error: null })));
    server.use(http.get('/v1/admin/ai-runs/run_8f1c', () => problem(404, 'Not found', { detail: 'That run was not found.', ref: 'cor_a2' })));
    renderApp('/admin/ai-runs');
    await userEvent.click(await screen.findByRole('button', { name: 'run_8f21' }));
    expect(await screen.findByText('Nothing came back.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Error' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'run_8f1c' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("This run didn't load");
    expect(alert).toHaveTextContent('That run was not found.');
  });

  it('shows a loading line while the run loads', async () => {
    serve();
    server.use(
      http.get('/v1/admin/ai-runs/run_8f21', async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    renderApp('/admin/ai-runs');
    await userEvent.click(await screen.findByRole('button', { name: 'run_8f21' }));
    expect(await screen.findByText('Loading the run')).toBeInTheDocument();
  });
});
