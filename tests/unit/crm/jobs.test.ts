import { describe, expect, it } from 'vitest';
import { activityPollJob, handoffPushJob, personPushJob, syncJob } from '@/modules/crm/contracts/jobs';

// A create that timed out may land in HubSpot after the retry's search, whose index lags: retries start at 30 s.
const PUSH_BACKOFF = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 3_600_000];

describe('CRM job options (final review C1, I7)', () => {
  it('pushes and person pushes back off from 30 seconds to an hour', () => {
    expect(handoffPushJob.opts.backoffMs).toEqual(PUSH_BACKOFF);
    expect(personPushJob.opts.backoffMs).toEqual(PUSH_BACKOFF);
  });

  it('a sync has two minutes, as the activity poll leaves each account to its own sync', () => {
    expect(syncJob.opts.timeoutMs).toBe(120_000);
    expect(activityPollJob.name).toBe('crm.activity.poll');
  });
});
