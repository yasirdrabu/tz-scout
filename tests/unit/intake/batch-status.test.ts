import { describe, expect, it } from 'vitest';
import { batchStatus, itemOutcome, progressLabel } from '@/modules/intake/domain/batch-status';

const base = { stored: 'completed', importStatus: null, importError: null, received: 0, resolving: 0, waiting: 0, capRejected: 0, retryable: 0 };

describe('batchStatus (Ruling 8)', () => {
  it('is failed when the linked import stopped, with its error as the issue', () => {
    expect(batchStatus({ ...base, stored: 'processing', importStatus: 'failed', importError: 'Import stopped: This source is paused' })).toEqual({
      key: 'failed',
      label: 'Failed',
      issue: 'Import stopped: This source is paused',
    });
    expect(batchStatus({ ...base, importStatus: 'failed', importError: 'The file went missing' }).issue).toBe('Import stopped: The file went missing');
  });

  it('is in progress while rows resolve or the import is queued', () => {
    expect(batchStatus({ ...base, stored: 'processing', received: 2 })).toEqual({ key: 'in_progress', label: 'In progress', issue: null });
    expect(batchStatus({ ...base, stored: 'processing' }).key).toBe('in_progress');
    expect(batchStatus({ ...base, importStatus: 'queued' }).key).toBe('in_progress');
    expect(batchStatus({ ...base, stored: 'processing', resolving: 1, waiting: 3 }).key).toBe('in_progress');
  });

  it('needs attention when rows wait for a person, even though the stored status stays processing', () => {
    expect(batchStatus({ ...base, stored: 'processing', waiting: 3 })).toEqual({
      key: 'needs_attention',
      label: 'Needs attention',
      issue: '3 rows need a website, a company or a duplicate check',
    });
    expect(batchStatus({ ...base, stored: 'processing', waiting: 1 }).issue).toBe('1 row needs a website, a company or a duplicate check');
  });

  it('needs attention when rows hit the daily limit and can be retried', () => {
    expect(batchStatus({ ...base, capRejected: 2, retryable: 2 })).toEqual({ key: 'needs_attention', label: 'Needs attention', issue: '2 rows hit the daily limit' });
    expect(batchStatus({ ...base, capRejected: 1, retryable: 1 }).issue).toBe('1 row hit the daily limit');
  });

  it('is complete otherwise', () => {
    expect(batchStatus(base)).toEqual({ key: 'complete', label: 'Complete', issue: null });
    expect(batchStatus({ ...base, importStatus: 'imported' }).key).toBe('complete');
  });
});

describe('progressLabel', () => {
  it('says what resolved, was rejected and waits', () => {
    expect(progressLabel({ received: 0, resolving: 0, waiting: 2, resolved: 5, rejected: 1 })).toBe('5 resolved, 1 rejected, 2 waiting');
  });
});

describe('itemOutcome (Ruling 9)', () => {
  it('gives the outcome and its words for each kind of row', () => {
    expect(itemOutcome({ status: 'resolved', resolution: 'created', reason: null, waitingOn: null, accountName: 'Acme' })).toEqual({
      outcome: 'new_account',
      label: 'Resolved: New account',
    });
    expect(itemOutcome({ status: 'resolved', resolution: 'attached', reason: null, waitingOn: null, accountName: 'Acme' }).label).toBe('Resolved: Matched Acme');
    expect(itemOutcome({ status: 'resolved', resolution: 'attached', reason: null, waitingOn: null, accountName: null }).label).toBe(
      'Resolved: Matched an existing account',
    );
    const rejected = (reason: string) => itemOutcome({ status: 'rejected', resolution: null, reason, waitingOn: null, accountName: null });
    expect(rejected('duplicate_in_batch')).toEqual({ outcome: 'rejected', label: 'Rejected: Duplicate of another row in this batch' });
    expect(rejected('invalid').label).toBe('Rejected: Invalid row');
    expect(rejected('excluded').label).toBe('Rejected: Excluded');
    expect(rejected('daily_cap_reached').label).toBe('Rejected: Daily limit reached');
    const waiting = (waitingOn: string) => itemOutcome({ status: 'resolving', resolution: null, reason: null, waitingOn, accountName: null });
    expect(waiting('needs_website')).toEqual({ outcome: 'waiting', label: 'Waiting: Needs a website' });
    expect(waiting('needs_company').label).toBe('Waiting: Needs a company');
    expect(waiting('possible_duplicate').label).toBe('Waiting: Possible duplicate');
    expect(itemOutcome({ status: 'received', resolution: null, reason: null, waitingOn: null, accountName: null })).toEqual({ outcome: 'resolving', label: 'Resolving' });
  });
});
