// Picking the current value of one fact key (ACC-E3). Pure: the service loads the facts, supplies trust and writes the result.

import type { SourceChain } from '../contracts/types';
import { isFreeTextKey, isListKey } from './fact-keys';

export type PickFact = {
  id: string;
  key: string;
  value: unknown;
  observedAt: Date;
  /** Pinned by a person (an edit, or the kept value of a resolved conflict). */
  pinned: boolean;
  sourceChain: SourceChain;
};

export type CurrentPick = {
  currentId: string | null;
  /** Older facts from a source that has since said something newer, or older free text. */
  supersededIds: string[];
  /** The value to project. For a list key this is the union; otherwise the current fact's value. */
  value: unknown;
};

/**
 * `facts` are all the live facts for ONE key. `trust(fact)` is the effective trust of the fact's source chain
 * (the service reads it through `SourceInfoProvider.getTrust`).
 *
 * Order: pinned, then highest trust, then newest `observedAt`, then id so the result never depends on input order.
 * A newer fact from the same source (same chain) supersedes that source's older fact. List keys (`technologies`,
 * `keywords`) union each source's latest fact. Free-text keys take the newest and supersede every older one.
 */
export function pickCurrent(facts: PickFact[], trust: (fact: PickFact) => number): CurrentPick {
  if (facts.length === 0) return { currentId: null, supersededIds: [], value: null };
  const key = facts[0]!.key;
  const newestFirst = (a: PickFact, b: PickFact) => b.observedAt.getTime() - a.observedAt.getTime() || a.id.localeCompare(b.id);

  if (isFreeTextKey(key)) {
    const sorted = [...facts].sort((a, b) => Number(b.pinned) - Number(a.pinned) || newestFirst(a, b));
    const [current, ...older] = sorted as [PickFact, ...PickFact[]];
    return { currentId: current.id, supersededIds: older.map((f) => f.id), value: current.value };
  }

  const chainKey = (c: SourceChain) => `${c.personSourceId ?? ''}|${c.agentSourceId ?? ''}|${c.vendorSourceId ?? ''}`;
  const latest = new Map<string, PickFact>();
  for (const f of [...facts].sort(newestFirst)) if (!latest.has(chainKey(f.sourceChain))) latest.set(chainKey(f.sourceChain), f);
  const supersededIds = facts.filter((f) => !f.pinned && latest.get(chainKey(f.sourceChain)) !== f).map((f) => f.id);

  const live = facts.filter((f) => f.pinned || latest.get(chainKey(f.sourceChain)) === f);
  const winner = [...live].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || trust(b) - trust(a) || newestFirst(a, b),
  )[0]!;

  if (isListKey(key)) {
    const union: unknown[] = [];
    for (const f of [...latest.values()].sort(newestFirst)) {
      for (const v of Array.isArray(f.value) ? f.value : []) if (!union.includes(v)) union.push(v);
    }
    return { currentId: winner.id, supersededIds, value: union };
  }
  return { currentId: winner.id, supersededIds, value: winner.value };
}
