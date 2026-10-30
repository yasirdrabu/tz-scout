import { describe, expect, it } from 'vitest';
import { batchName, followThroughCounts, notSentReason } from '@/modules/crm/domain/batch';
import { handoffMessage, handoffMessages, replyBy } from '@/modules/crm/domain/message';

const timezone = 'America/New_York';
const at = new Date('2026-10-29T15:00:00Z'); // a Thursday

const accounts = [
  { name: 'Acme', domain: 'acme.com', offer: 'Cloud migration', buyer: { name: 'Pat Lee', title: 'CTO', email: 'pat@acme.com' }, crmUrl: 'https://app.hubspot.com/contacts/123/record/0-2/9' },
  { name: 'Globex', domain: 'globex.com', offer: null, buyer: null, crmUrl: null },
];

// Pasted from the output of v1's `handoffMessage` for the same input (reference/v1/src/lib/handoff.ts).
const V1_TEXT = `Hi Mike, 2 new accounts are in HubSpot for you.

1. Acme (acme.com): Cloud migration. Start with Pat Lee, CTO (pat@acme.com).
   https://app.hubspot.com/contacts/123/record/0-2/9
2. Globex (globex.com). No buyer contact yet; the note lists who to look for.

Each one has a note on the company with why it's a fit, why now, the offer and who to talk to, plus a first-touch task due today and three dated follow-up emails as tasks (days 3, 7 and 14). They're under your Tasks in HubSpot.

Ask: make the first touch on each by Monday, Nov 2, and mark the tasks done in HubSpot as you go so we can see where they stand. If one isn't a fit, say so and I'll pull it back.

Lena`;

describe('handoff message (CRM-E4-S2-AC3)', () => {
  it('equals the v1 text for the same input, the fixed date and days 3, 7 and 14', () => {
    expect(handoffMessage({ seller: 'Mike Stone', from: 'Lena Park', accounts, at, timezone, followUpDays: [3, 7, 14] })).toBe(V1_TEXT);
  });

  it('takes the follow-up days from the setting', () => {
    const text = (days: number[]) => handoffMessage({ seller: 'Mike', from: null, accounts: accounts.slice(0, 1), at, timezone, followUpDays: days });
    expect(text([2, 5])).toContain('two dated follow-up emails as tasks (days 2 and 5)');
    expect(text([4])).toContain('one dated follow-up email as a task (day 4)');
    expect(text([1, 2, 3, 4, 5])).toContain('five dated follow-up emails as tasks (days 1, 2, 3, 4 and 5)');
  });

  it('speaks of one account in the singular and leaves the signature off with no leader', () => {
    const text = handoffMessage({ seller: 'Mike', from: null, accounts: accounts.slice(0, 1), at, timezone, followUpDays: [3, 7, 14] });
    expect(text).toContain('1 new account is in HubSpot');
    expect(text).toContain('make the first touch on it by');
    expect(text.endsWith("I'll pull it back.")).toBe(true);
  });

  it('groups by seller, one message each', () => {
    const out = handoffMessages({
      from: 'Lena Park',
      at,
      timezone,
      followUpDays: [3, 7, 14],
      accounts: [
        { ...accounts[0]!, sellerId: 'usr_a', seller: 'Mike Stone' },
        { ...accounts[1]!, sellerId: 'usr_b', seller: 'Ash Rao' },
        { ...accounts[1]!, name: 'Initech', sellerId: 'usr_a', seller: 'Mike Stone' },
      ],
    });
    expect(out.map((m) => [m.seller, m.count])).toEqual([['Mike Stone', 2], ['Ash Rao', 1]]);
  });
});

describe('reply by', () => {
  it('counts two working days in the tenant timezone', () => {
    const day = (d: string, tz = timezone) => replyBy(new Date(d), tz).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
    expect(day('2026-10-29T15:00:00Z')).toBe('Mon, Nov 2'); // Thu -> Mon
    expect(day('2026-10-26T15:00:00Z')).toBe('Wed, Oct 28'); // Mon -> Wed
    expect(day('2026-10-31T15:00:00Z')).toBe('Tue, Nov 3'); // Sat -> Tue
    // 02:00 UTC Friday is still Thursday evening in New York, and already Friday in Sydney.
    expect(day('2026-10-30T02:00:00Z')).toBe('Mon, Nov 2');
    expect(day('2026-10-30T02:00:00Z', 'Australia/Sydney')).toBe('Tue, Nov 3');
  });
});

describe('batch name', () => {
  it('names one account after it and the seller', () => {
    expect(batchName([{ name: 'Acme', seller: 'Mike Stone' }], at, timezone)).toBe('Oct 29 · Acme to Mike');
  });

  it('counts per seller for a bulk', () => {
    const m = (seller: string) => ({ name: 'x', seller });
    expect(batchName([m('Mike Stone'), m('Mike Stone'), m('Mike Stone'), m('Ash Rao'), m('Ash Rao')], at, timezone)).toBe('Oct 29 · 3 to Mike, 2 to Ash');
  });

  it('uses the tenant calendar day', () => {
    expect(batchName([{ name: 'Acme', seller: 'Mike' }], new Date('2026-10-30T02:00:00Z'), timezone)).toBe('Oct 29 · Acme to Mike');
  });
});

describe('not sent reasons and counts', () => {
  it('gives each unsent status a reason', () => {
    expect(notSentReason({ status: 'failed', lastError: 'HubSpot refused the token. Enter a new one in Integrations.', decisionReason: null })).toMatch(/^HubSpot refused/);
    expect(notSentReason({ status: 'needs_decision', lastError: null, decisionReason: 'open_deal' })).toMatch(/open deal/);
    expect(notSentReason({ status: 'cancelled', lastError: null, decisionReason: null })).toMatch(/cancelled/);
  });

  it('counts since the handoff and never below 0', () => {
    expect(
      followThroughCounts({
        baseline: { emails: 2, calls: 5 },
        latest: { emails: 5, calls: 3, openDeals: 1 },
        tasks: [{ status: 'COMPLETED' }, { status: 'NOT_STARTED' }],
      }),
    ).toEqual({ tasksDone: 1, tasksTotal: 2, emails: 3, calls: 0, meetings: 0, deals: 0, openDeals: 1 });
  });
});
