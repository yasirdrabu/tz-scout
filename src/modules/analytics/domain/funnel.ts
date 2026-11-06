// Funnel counts, spend attribution and cost status (R3b-1 Rulings 3-6 and 9). Pure: no database, no clock.
import type { Journey } from '../services/journeys';

export type StageDef = { key: string; name: string; kind: 'flow' | 'exit'; assigned: boolean };

export type CostStatus = 'not_enough_data' | 'no_wins' | 'no_target' | 'good' | 'amber' | 'red';

/** `Math.round(n / d)`, or null when `d` is 0. */
export const ratio = (n: number, d: number): number | null => (d === 0 ? null : Math.round(n / d));

/** The furthest flow position an account reached; 0 when it only arrived. Keys outside `flow` are ignored. */
export function reachedIndex(j: Journey, flow: StageDef[]): number {
  let best = 0;
  flow.forEach((s, i) => {
    if (i > best && j.stages.has(s.key)) best = i;
  });
  return best;
}

/** Per flow stage, the accounts that reached it or any later stage (a skipped stage counts as passed). */
export function stageCounts(js: Journey[], flow: StageDef[]): number[] {
  const counts = flow.map(() => 0);
  for (const j of js) {
    const r = reachedIndex(j, flow);
    for (let k = 0; k <= r; k++) counts[k]! += 1;
  }
  return counts;
}

/** Each count as a rounded percentage of the one before; null for the first stage or a zero base. */
export const stepPct = (counts: number[]): (number | null)[] =>
  counts.map((c, k) => (k === 0 || counts[k - 1] === 0 ? null : Math.round((c * 100) / counts[k - 1]!)));

/** Per flow stage, the accounts whose furthest stage it is and that have an exit. */
export function lostAt(js: Journey[], flow: StageDef[]): number[] {
  const lost = flow.map(() => 0);
  for (const j of js) if (j.exitStage) lost[reachedIndex(j, flow)]! += 1;
  return lost;
}

/** The source and everything below it in the tree (source to direct children). Safe against cycles. */
export function rollUp(sourceId: string, tree: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([sourceId]);
  const stack = [sourceId];
  while (stack.length) {
    for (const c of tree.get(stack.pop()!) ?? []) {
      if (!seen.has(c)) {
        seen.add(c);
        stack.push(c);
      }
    }
  }
  return seen;
}

/** Spend per source: the line's source, else its account's first source, else shared. Nothing is dropped. */
export function spendBySource(
  lines: { amountCents: number; sourceId: string | null; accountId: string | null }[],
  firstSourceOf: Map<string, string>,
): { bySource: Map<string, number>; shared: number } {
  const bySource = new Map<string, number>();
  let shared = 0;
  for (const l of lines) {
    const sid = l.sourceId ?? (l.accountId ? firstSourceOf.get(l.accountId) ?? null : null);
    if (sid) bySource.set(sid, (bySource.get(sid) ?? 0) + l.amountCents);
    else shared += l.amountCents;
  }
  return { bySource, shared };
}

/** Cost per won account against the target, checked in this order (Ruling 9). */
export function costStatus(sent: number, won: number, costPerWonCents: number | null, targetCents: number | null): CostStatus {
  if (sent < 10) return 'not_enough_data';
  if (won === 0 || costPerWonCents === null) return 'no_wins';
  if (targetCents === null) return 'no_target';
  if (costPerWonCents <= targetCents) return 'good';
  // Whole-number comparison for 1.5x.
  return costPerWonCents * 2 <= targetCents * 3 ? 'amber' : 'red';
}

/** The plain-words read of a source's funnel; null when nothing was lost. */
export function insight(counts: number[], names: string[], sent: number): string | null {
  if (sent < 10) return 'Too early to judge.';
  let at = -1;
  let most = 0;
  for (let k = 1; k < counts.length; k++) {
    const loss = counts[k - 1]! - counts[k]!;
    if (loss > most) {
      most = loss;
      at = k;
    }
  }
  return at < 0 ? null : `Most accounts stall between ${names[at - 1]} and ${names[at]}.`;
}
