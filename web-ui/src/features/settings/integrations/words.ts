import type { PillTone } from '../../../ui/Pill';
import type { Cap, Integration } from './api';

/** The status dot and words for a service row. */
export function statusOf(s: Integration): { tone: PillTone; text: string } {
  if (s.status === 'disabled') return { tone: 'neutral', text: 'Turned off' };
  if (s.status === 'failing') return { tone: 'bad', text: 'Failing' };
  if (s.status === 'connected') return { tone: 'good', text: 'Working' };
  if (s.credentials.length > 0) return { tone: 'near', text: 'Saved, not tested yet' };
  return { tone: 'neutral', text: 'Not set up' };
}

export const modeText = (s: Integration) => (s.mode === 'live' ? 'Live' : 'Using sample data');

/** "Calls today": "{n}", or "{n} of {cap}/day" with usage caps (R1d). */
export const callsText = (s: Integration, n: (x: number) => string) =>
  s.calls_today_cap === null ? n(s.calls_today) : `${n(s.calls_today)} of ${n(s.calls_today_cap)}/day`;

const periodWord = (c: Cap) => (c.period === 'day' ? 'daily' : 'monthly');

/** Banner lines for the Integrations tab: blocked first, then overage, then warn. `date` formats a reset like "Dec 1". */
export function capLines(rows: Integration[], date: (iso: string) => string): string[] {
  const lines = rows.flatMap((r) => {
    const c = r.cap;
    if (!c || c.level === 'ok') return [];
    if (c.overage) return [{ rank: 1, text: `${r.name} is allowed over its limit until ${date(c.resets_at)}.` }];
    if (c.level === 'blocked') return [{ rank: 0, text: `${r.name} reached its ${periodWord(c)} limit. Scout stopped calling it until ${date(c.resets_at)}.` }];
    return [{ rank: 2, text: `${r.name} has used ${Math.floor((c.used * 100) / c.limit)}% of its ${periodWord(c)} limit.` }];
  });
  return lines.sort((a, b) => a.rank - b.rank).map((l) => l.text);
}

/** "{n} of {m} services working" and one sentence per issue. Services nobody has set up don't count. */
export function summaryOf(rows: Integration[]): { line: string; issues: string[] } {
  const setUp = rows.filter((r) => r.status === 'connected' || r.status === 'failing' || r.credentials.length > 0);
  const working = setUp.filter((r) => r.status === 'connected').length;
  const issues = setUp.flatMap((r) => {
    if (r.status === 'failing') return [r.last_error ? `${r.name} is failing: ${r.last_error}` : `${r.name} is failing.`];
    if (r.status === 'not_set_up') return [`${r.name} has not been tested yet.`];
    return [];
  });
  const line = setUp.length === 0 ? 'No services are set up yet.' : `${working} of ${setUp.length} services working`;
  return { line, issues };
}
