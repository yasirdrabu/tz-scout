import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { formatDateTime } from '../../../lib/format';
import { exactly, problem } from '../../../test/http';
import { renderApp, serveNoTenantMe } from '../../../test/renderApp';
import { server } from '../../../test/server';
import { REFRESH_MS, type Health } from './api';

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const HEALTH: Health = {
  relay_lag_ms: 1800,
  queues_available: true,
  pending_total: 45,
  queues: [
    { name: 'enrichment', pending: 40, ack_pending: 2, oldest_age_ms: 360_000 },
    { name: 'scoring', pending: 3, ack_pending: 0, oldest_age_ms: 40_000 },
    { name: 'email-relay', pending: 0, ack_pending: 0, oldest_age_ms: null },
  ],
  dead_job_count: 2,
  dead_jobs: [
    {
      id: 'job_7f3a19',
      tenant_id: 't_taazaa',
      tenant_name: 'Taazaa',
      name: 'hubspot-push',
      last_error: 'HubSpot returned 409: company 88213 already has an owner.',
      attempts: 6,
      dead_at: '2026-10-31T14:12:00Z',
    },
    { id: 'job_7f2c04', tenant_id: 't_bright', tenant_name: null, name: 'enrichment', last_error: null, attempts: 6, dead_at: '2026-10-31T13:41:00Z' },
  ],
  schedules: [
    {
      id: 'sch_rfp',
      tenant_id: 't_taazaa',
      tenant_name: 'Taazaa',
      job_name: 'rfp-watch-nightly',
      cron: '0 6 * * *',
      timezone: 'America/New_York',
      enabled: true,
      next_run_at: '2026-11-01T10:00:00Z',
      last_run_at: '2026-10-31T10:00:00Z',
    },
    {
      id: 'sch_apollo',
      tenant_id: 't_taazaa',
      tenant_name: 'Taazaa',
      job_name: 'apollo-refresh',
      cron: '0 3 */7 * *',
      timezone: 'UTC',
      enabled: false,
      next_run_at: null,
      last_run_at: null,
    },
  ],
  ai_spend_today_cents: 4120,
};

let calls = 0;

function serve(health: Health = HEALTH) {
  calls = 0;
  serveNoTenantMe();
  server.use(
    http.get('/v1/admin/health', () => {
      calls++;
      return HttpResponse.json(health);
    }),
  );
}

beforeEach(() => localStorage.clear());

describe('System health', () => {
  it('shows the tiles, pending work by queue, dead jobs and schedules', async () => {
    serve();
    renderApp('/admin/health');
    expect(await screen.findByRole('heading', { level: 1, name: 'System health' })).toBeInTheDocument();
    expect(screen.getByText('All tenants · refreshed every 15 seconds')).toBeInTheDocument();
    expect(await screen.findByText('1.8 s')).toBeInTheDocument();
    expect(screen.getByText('Target under 5 s')).toBeInTheDocument();
    expect(screen.getByText('Across 3 queues')).toBeInTheDocument();
    expect(screen.getByText('Need a decision')).toBeInTheDocument();
    expect(screen.getByText('$41.20')).toBeInTheDocument();

    const queues = screen.getByRole('region', { name: 'Pending work by queue' });
    expect(within(queues).getByText('enrichment').closest('li')).toHaveTextContent('42Oldest 6 min');
    expect(within(queues).getByText('scoring').closest('li')).toHaveTextContent('Oldest 40 s');
    expect(within(queues).getByText('email-relay').closest('li')).toHaveTextContent('Empty');

    const dead = screen.getByRole('region', { name: 'Dead jobs' });
    const first = within(dead).getByText('job_7f3a19').closest('li')!;
    expect(first).toHaveTextContent(`hubspot-push · Taazaa · ${formatDateTime('2026-10-31T14:12:00Z', zone)}`);
    expect(first).toHaveTextContent('Failed 6 times and stopped retrying');
    expect(first).toHaveTextContent('HubSpot returned 409: company 88213 already has an owner.');
    expect(within(dead).getByText('job_7f2c04').closest('li')).toHaveTextContent('enrichment · t_bright');

    const schedules = screen.getByRole('region', { name: 'Schedules' });
    const rfp = within(schedules).getByText('rfp-watch-nightly').closest('tr')!;
    expect(rfp).toHaveTextContent('0 6 * * *');
    expect(rfp).toHaveTextContent(formatDateTime('2026-11-01T10:00:00Z', zone));
    const apollo = within(schedules).getByText('apollo-refresh').closest('tr')!;
    expect(apollo).toHaveTextContent('Paused');
    expect(apollo).toHaveTextContent('Never');
    expect(within(apollo).getByRole('button', { name: 'Resume apollo-refresh for Taazaa' })).toBeInTheDocument();
  });

  it('shows the empty sections, and says when the queues are unavailable', async () => {
    serve({ ...HEALTH, queues_available: false, queues: [], pending_total: 0, dead_job_count: 0, dead_jobs: [], schedules: [] });
    renderApp('/admin/health');
    expect(await screen.findByText('Queue details are unavailable right now.')).toBeInTheDocument();
    expect(screen.getByText('No dead jobs. Jobs that fail every try show here so you can retry or discard them.')).toBeInTheDocument();
    expect(screen.getByText('No schedules yet.')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('shows loading and error states', async () => {
    serveNoTenantMe();
    server.use(
      http.get('/v1/admin/health', async () => {
        await delay('infinite');
        return HttpResponse.json(HEALTH);
      }),
    );
    const first = renderApp('/admin/health');
    expect(await screen.findByText('Loading system health')).toBeInTheDocument();
    first.unmount();

    server.use(http.get('/v1/admin/health', () => problem(500, 'Something went wrong', { detail: 'The database is down.', ref: 'cor_h1' })));
    renderApp('/admin/health');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("System health didn't load");
    expect(alert).toHaveTextContent('The database is down.');
    expect(within(alert).getByText('Error ref cor_h1')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('refreshes every 15 seconds while the page is visible, and not in the background', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      serve();
      renderApp('/admin/health');
      await screen.findByText('1.8 s');
      expect(calls).toBe(1);
      await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS));
      await waitFor(() => expect(calls).toBe(2));

      act(() => focusManager.setFocused(false));
      await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS * 2));
      expect(calls).toBe(2);
    } finally {
      act(() => focusManager.setFocused(undefined));
      vi.useRealTimers();
    }
  });
});

describe('test event', () => {
  it('shows the round trip, and the API words when nothing answers', async () => {
    serve();
    server.use(http.post('/v1/admin/test-event', () => problem(504, 'No answer after 10 seconds. Check the worker and relay.', { slug: 'no-answer' })));
    renderApp('/admin/health');
    await screen.findByText('1.8 s');
    await userEvent.click(screen.getByRole('button', { name: 'Send test event' }));
    expect(await screen.findByText('No answer after 10 seconds. Check the worker and relay.')).toBeInTheDocument();

    server.use(http.post('/v1/admin/test-event', () => HttpResponse.json({ round_trip_ms: 412 })));
    await userEvent.click(screen.getByRole('button', { name: 'Send test event' }));
    expect(await screen.findByText('Round trip 412 ms. Relay, queue and worker all answered.')).toBeInTheDocument();
  });
});

describe('dead jobs', () => {
  it('retries a job, and shows the failure', async () => {
    serve();
    server.use(http.post(exactly('/v1/admin/jobs/job_7f3a19:retry'), () => problem(404, 'Dead job not found', { detail: 'No dead job job_7f3a19' })));
    renderApp('/admin/health');
    await userEvent.click(await screen.findByRole('button', { name: 'Retry job_7f3a19' }));
    expect(await screen.findByText('No dead job job_7f3a19')).toBeInTheDocument();

    server.use(http.post(exactly('/v1/admin/jobs/job_7f3a19:retry'), () => HttpResponse.json({ sent_id: 'evt_1' })));
    await userEvent.click(screen.getByRole('button', { name: 'Retry job_7f3a19' }));
    expect(await screen.findByText('job_7f3a19 sent back to hubspot-push')).toBeInTheDocument();
    await waitFor(() => expect(calls).toBeGreaterThan(1));
  });

  it('discards a job after the confirm, and shows the failure', async () => {
    serve();
    server.use(http.post(exactly('/v1/admin/jobs/job_7f2c04:discard'), () => problem(404, 'Dead job not found', { detail: 'No dead job job_7f2c04' })));
    renderApp('/admin/health');
    await userEvent.click(await screen.findByRole('button', { name: 'Discard job_7f2c04' }));
    const confirm = await screen.findByRole('dialog', { name: 'Discard job_7f2c04?' });
    expect(confirm).toHaveTextContent('Scout deletes the job and never runs it again.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('No dead job job_7f2c04')).toBeInTheDocument();

    server.use(http.post(exactly('/v1/admin/jobs/job_7f2c04:discard'), () => new HttpResponse(null, { status: 204 })));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('job_7f2c04 discarded')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the rows in place when a refresh changes them, and applies them from the updates bar', async () => {
    serve();
    const NEW = { ...HEALTH.dead_jobs[1]!, id: 'job_80aa01', name: 'scoring' };
    const app = renderApp('/admin/health');
    await screen.findByRole('button', { name: 'Retry job_7f3a19' });
    expect(screen.queryByText(/updates?$/)).toBeNull();

    // The next refresh: job_7f3a19 is gone, job_7f2c04 failed again, job_80aa01 is new.
    server.use(
      http.get('/v1/admin/health', () =>
        HttpResponse.json({ ...HEALTH, dead_job_count: 2, dead_jobs: [NEW, { ...HEALTH.dead_jobs[1]!, attempts: 7 }] }),
      ),
    );
    await act(() => app.queryClient.invalidateQueries());
    expect(await screen.findByText('3 updates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry job_7f3a19' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry job_80aa01' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.queryByRole('button', { name: 'Retry job_7f3a19' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry job_80aa01' })).toBeInTheDocument();
    expect(screen.getByText('Failed 7 times and stopped retrying')).toBeInTheDocument();
    expect(screen.queryByText(/updates?$/)).toBeNull();
  });

  it('drops a retried job at once, with no updates bar', async () => {
    serve();
    let retried = false;
    server.use(
      http.post(exactly('/v1/admin/jobs/job_7f3a19:retry'), () => {
        retried = true;
        return HttpResponse.json({ sent_id: 'evt_1' });
      }),
      http.get('/v1/admin/health', () =>
        HttpResponse.json(retried ? { ...HEALTH, dead_job_count: 1, dead_jobs: [HEALTH.dead_jobs[1]] } : HEALTH),
      ),
    );
    renderApp('/admin/health');
    await userEvent.click(await screen.findByRole('button', { name: 'Retry job_7f3a19' }));
    expect(await screen.findByText('job_7f3a19 sent back to hubspot-push')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry job_7f3a19' })).toBeNull();
    expect(screen.queryByText(/updates?$/)).toBeNull();
  });

  it('cancels the discard with Esc and returns focus', async () => {
    serve();
    renderApp('/admin/health');
    const discard = await screen.findByRole('button', { name: 'Discard job_7f2c04' });
    await userEvent.click(discard);
    await screen.findByRole('dialog', { name: 'Discard job_7f2c04?' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(discard).toHaveFocus();
  });
});

describe('schedules', () => {
  it('pauses, resumes and runs now, and shows the failures', async () => {
    serve();
    server.use(
      http.post(exactly('/v1/admin/schedules/sch_rfp:pause'), () => problem(404, 'Not found', { detail: 'That schedule was not found.' })),
      http.post(exactly('/v1/admin/schedules/sch_apollo:resume'), () => problem(500, 'Something went wrong', { detail: 'Resume failed.' })),
      http.post(exactly('/v1/admin/schedules/sch_rfp:run-now'), () => problem(500, 'Something went wrong', { detail: 'Run failed.' })),
    );
    renderApp('/admin/health');
    await userEvent.click(await screen.findByRole('button', { name: 'Pause rfp-watch-nightly for Taazaa' }));
    expect(await screen.findByText('That schedule was not found.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume apollo-refresh for Taazaa' }));
    expect(await screen.findByText('Resume failed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run rfp-watch-nightly for Taazaa now' }));
    expect(await screen.findByText('Run failed.')).toBeInTheDocument();

    server.use(
      http.post(exactly('/v1/admin/schedules/sch_rfp:pause'), () => new HttpResponse(null, { status: 204 })),
      http.post(exactly('/v1/admin/schedules/sch_apollo:resume'), () => new HttpResponse(null, { status: 204 })),
      http.post(exactly('/v1/admin/schedules/sch_rfp:run-now'), () => HttpResponse.json({ job_id: 'job_1' })),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pause rfp-watch-nightly for Taazaa' }));
    expect(await screen.findByText('rfp-watch-nightly paused')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume apollo-refresh for Taazaa' }));
    expect(await screen.findByText('apollo-refresh resumed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run rfp-watch-nightly for Taazaa now' }));
    expect(await screen.findByText('rfp-watch-nightly started')).toBeInTheDocument();
  });
});
