import { ActionForm, AutoRefresh, SubmitButton } from '@/components/client';
import { AdminShell } from '@/components/shell';
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, Table, Td, Th } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { scrubError } from '@/platform/scrub-error';
import { listDeadJobs } from '@/platform/dead-jobs';
import { systemHealth } from '@/platform/health';
import { adminContext } from '@/server/page-context';
import {
  discardDeadJobAction,
  pauseScheduleAction,
  resumeScheduleAction,
  retryDeadJobAction,
  runNowAction,
  sendTestEventAction,
} from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'System' };

function IdForm({ action, id, children }: { action: Parameters<typeof ActionForm>[0]['action']; id: string; children: React.ReactNode }) {
  return (
    <ActionForm action={action} className="inline-block">
      <input type="hidden" name="id" value={id} />
      {children}
    </ActionForm>
  );
}

export default async function SystemPage() {
  const admin = await adminContext();
  const [health, dead] = await Promise.all([systemHealth(), listDeadJobs({ limit: 100 })]);
  const lagTone = health.relayLagMs > 30_000 ? 'bad' : health.relayLagMs > 5_000 ? 'near' : 'good';
  return (
    <AdminShell user={admin} current="system">
      <AutoRefresh />
      <PageHeader
        title="System"
        description="Whether messages and background work are flowing. This page refreshes every 30 seconds."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-ink-muted">Relay lag</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="tnum text-xl font-semibold" data-testid="count-lag">
              {health.relayLagMs.toLocaleString('en-US')} ms
            </span>
            <Badge tone={lagTone}>{lagTone === 'good' ? 'On time' : lagTone === 'near' ? 'Slow' : 'Stuck'}</Badge>
          </div>
          <div className="mt-1 text-2xs text-ink-muted">Age of the oldest message not yet sent.</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-ink-muted">Dead jobs</div>
          <div className="mt-1 tnum text-xl font-semibold" data-testid="count-dead">
            {health.deadJobs.toLocaleString('en-US')}
          </div>
          <div className="mt-1 text-2xs text-ink-muted">Work that failed every attempt.</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-ink-muted">Test event</div>
          <ActionForm action={sendTestEventAction} className="mt-1">
            <SubmitButton variant="secondary" pendingText="Waiting for an answer">
              Send test event
            </SubmitButton>
          </ActionForm>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader title="Consumers" description="Messages waiting for each background reader." />
        {!health.consumersAvailable ? (
          <div className="p-4">
            <Notice tone="near" title="Message service unavailable">
              Could not reach the message service, so consumer numbers are not shown. Everything else on this page is current.
            </Notice>
          </div>
        ) : health.consumers.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No consumers yet">Start the worker to see its readers here.</EmptyState>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Consumer</Th>
                <Th numeric>Waiting</Th>
                <Th numeric>Being handled</Th>
              </tr>
            </thead>
            <tbody>
              {health.consumers.map((c) => (
                <tr key={c.name}>
                  <Td className="font-mono text-xs">{c.name}</Td>
                  <Td numeric>{c.pending.toLocaleString('en-US')}</Td>
                  <Td numeric>{c.ackPending.toLocaleString('en-US')}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader title={`Dead jobs (${health.deadJobs})`} description="Retry sends the work again. Discard removes it." />
        {dead.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No dead jobs">Nothing has failed every attempt.</EmptyState>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Job</Th>
                <Th>Workspace</Th>
                <Th>Last error</Th>
                <Th numeric>Attempts</Th>
                <Th>Failed at</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {dead.map((d) => (
                <tr key={d.id} data-testid={`dead-${d.id}`}>
                  <Td className="font-mono text-xs">{d.name}</Td>
                  <Td className="font-mono text-xs">{d.tenantId}</Td>
                  <Td className="max-w-xs break-words text-xs">{scrubError(d.lastError)}</Td>
                  <Td numeric>{d.attempts}</Td>
                  <Td className="whitespace-nowrap text-xs">{formatDateTime(d.deadAt)}</Td>
                  <Td>
                    <div className="flex gap-2">
                      <IdForm action={retryDeadJobAction} id={d.id}>
                        <SubmitButton variant="secondary" size="sm" pendingText="Sending">
                          Retry
                        </SubmitButton>
                      </IdForm>
                      <IdForm action={discardDeadJobAction} id={d.id}>
                        <SubmitButton variant="danger" size="sm" pendingText="Discarding">
                          Discard
                        </SubmitButton>
                      </IdForm>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Schedules" description="Work that starts on a timer." />
        {health.schedules.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No schedules yet">Schedules appear here when a feature adds one.</EmptyState>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Job</Th>
                <Th>Workspace</Th>
                <Th>When</Th>
                <Th>Next run</Th>
                <Th>Last run</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {health.schedules.map((s) => (
                <tr key={s.id} data-testid={`schedule-${s.id}`}>
                  <Td className="font-mono text-xs">{s.jobName}</Td>
                  <Td className="font-mono text-xs">{s.tenantId}</Td>
                  <Td className="text-xs">
                    <span className="font-mono">{s.cron}</span> ({s.timezone})
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{formatDateTime(s.nextRunAt)}</Td>
                  <Td className="whitespace-nowrap text-xs">{formatDateTime(s.lastRunAt)}</Td>
                  <Td>
                    <Badge tone={s.enabled ? 'good' : 'muted'}>{s.enabled ? 'Running' : 'Paused'}</Badge>
                  </Td>
                  <Td>
                    <div className="flex gap-2">
                      {s.enabled ? (
                        <IdForm action={pauseScheduleAction} id={s.id}>
                          <SubmitButton variant="secondary" size="sm">
                            Pause
                          </SubmitButton>
                        </IdForm>
                      ) : (
                        <IdForm action={resumeScheduleAction} id={s.id}>
                          <SubmitButton variant="secondary" size="sm">
                            Resume
                          </SubmitButton>
                        </IdForm>
                      )}
                      <IdForm action={runNowAction} id={s.id}>
                        <SubmitButton variant="secondary" size="sm" pendingText="Starting">
                          Run now
                        </SubmitButton>
                      </IdForm>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </AdminShell>
  );
}
