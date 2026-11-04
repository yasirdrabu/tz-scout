import { describe, expect, it } from 'vitest';
import { REQUEST_STATUSES, type RequestStatus } from '@/modules/enrichment/contracts/types';
import { canTransition, statusText, type StatusFields } from '@/modules/enrichment/domain/status';

const row = (o: Partial<StatusFields>): StatusFields => ({ status: 'flagged', waitingReason: null, result: null, error: null, declineReason: null, ...o });

describe('canTransition (Ruling 7)', () => {
  const allowed: [RequestStatus, RequestStatus][] = [
    ['flagged', 'approved'],
    ['flagged', 'declined'],
    ['flagged', 'cancelled'],
    ['approved', 'running'],
    ['approved', 'cancelled'],
    ['running', 'completed'],
    ['running', 'partial'],
    ['running', 'failed'],
  ];

  it.each(allowed)('%s → %s is allowed', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('refuses every other move, completed → running among them', () => {
    expect(canTransition('completed', 'running')).toBe(false);
    const ok = new Set(allowed.map(([f, t]) => `${f}>${t}`));
    for (const from of REQUEST_STATUSES)
      for (const to of REQUEST_STATUSES) if (!ok.has(`${from}>${to}`)) expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
  });
});

describe('statusText (Global Constraints)', () => {
  it('reads each status', () => {
    expect(statusText(row({ status: 'flagged' }))).toBe('Waiting for approval');
    expect(statusText(row({ status: 'approved' }))).toBe('Starting');
    expect(statusText(row({ status: 'approved', waitingReason: 'Waiting for budget: Apollo monthly limit reached' }))).toBe(
      'Waiting for budget: Apollo monthly limit reached',
    );
    expect(statusText(row({ status: 'running' }))).toBe('Running');
    expect(statusText(row({ status: 'completed', result: { found: 4 } }))).toBe('Found 4');
    expect(statusText(row({ status: 'completed', result: { found: 0, message: 'Apollo found no one for Champion' } }))).toBe('Apollo found no one for Champion');
    expect(statusText(row({ status: 'partial', result: { found: 2, message: 'Stopped at the Apollo monthly limit.' } }))).toBe(
      'Found 2. Stopped at the Apollo monthly limit.',
    );
    expect(statusText(row({ status: 'failed', error: { kind: 'auth', message: 'Apollo rejected the key.' } }))).toBe('Apollo rejected the key.');
    expect(statusText(row({ status: 'declined', declineReason: 'Not this quarter' }))).toBe('Declined: Not this quarter');
    expect(statusText(row({ status: 'cancelled' }))).toBe('Cancelled');
    expect(statusText(row({ status: 'cancelled', declineReason: 'expired' }))).toBe('Expired after 14 days');
  });

  it('a running request shows the limit it waits on, else the error its retry is waiting out', () => {
    const waiting = 'Waiting for budget: Apollo monthly limit reached';
    expect(statusText(row({ status: 'running', waitingReason: waiting }))).toBe(waiting);
    expect(statusText(row({ status: 'running', error: { kind: 'unknown', message: 'Something went wrong. Try again.' } }))).toBe(
      'Something went wrong. Try again.',
    );
  });

  it('a stale waiting reason shows only while approved or running', () => {
    const waiting = 'Waiting for budget: Apollo monthly limit reached';
    expect(statusText(row({ status: 'cancelled', waitingReason: waiting }))).toBe('Cancelled');
    expect(statusText(row({ status: 'completed', waitingReason: waiting, result: { found: 2 } }))).toBe('Found 2');
  });
});
