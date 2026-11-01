import type { Cutoffs, Draft, Weights } from './api';

export const WEIGHT_KEYS = ['fit', 'intent', 'revenue', 'trust'] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];

export const STEP = 5;
export const MAX_WEIGHT = 60;

export const total = (w: Weights) => w.fit + w.intent + w.revenue + w.trust;

/**
 * Scales the weights other than `fixed` in proportion so all four add to 100, each a multiple of 5 within 0 to 60,
 * sharing out the steps by largest remainder. With no `fixed`, all four scale.
 */
export function balance(weights: Weights, fixed?: WeightKey): Weights {
  const free = WEIGHT_KEYS.filter((k) => k !== fixed);
  const steps = (100 - (fixed ? weights[fixed] : 0)) / STEP;
  const cap = MAX_WEIGHT / STEP;
  const have = free.reduce((n, k) => n + weights[k], 0);
  // Nothing to scale (all zero): share evenly.
  const basis = (k: WeightKey) => (have === 0 ? 1 : weights[k]);
  const basisTotal = have === 0 ? free.length : have;
  const rows = free.map((k) => {
    const exact = (basis(k) * steps) / basisTotal;
    const base = Math.min(cap, Math.floor(exact));
    return { k, base, rest: base >= cap ? -1 : exact - Math.floor(exact) };
  });
  let left = steps - rows.reduce((n, r) => n + r.base, 0);
  const order = [...rows].sort((a, b) => b.rest - a.rest);
  while (left > 0 && order.some((r) => r.base < cap)) {
    for (const r of order) {
      if (left > 0 && r.base < cap) {
        r.base++;
        left--;
      }
    }
  }
  const out = { ...weights };
  for (const r of rows) out[r.k] = r.base * STEP;
  return out;
}

/** The sentences under the cutoffs and beside the total; empty when the draft is fine. */
export function problems(draft: Draft): { weights: string | null; cutoffs: string[] } {
  const sum = total(draft.weights);
  const c: Cutoffs = draft.tier_cutoffs;
  const cutoffs: string[] = [];
  if (!(c.act_now > c.good_fit)) cutoffs.push('Act now has to start higher than Good fit.');
  if (!(c.good_fit > c.watch)) cutoffs.push('Good fit has to start higher than Watch.');
  if (c.act_now > 100) cutoffs.push('Act now has to be 100 or less.');
  if (c.watch < 1) cutoffs.push('Watch has to be at least 1.');
  return { weights: sum === 100 ? null : `Weights add up to ${sum}. Make them add up to 100.`, cutoffs };
}

export const isValid = (draft: Draft) => {
  const p = problems(draft);
  return p.weights === null && p.cutoffs.length === 0;
};

/** A copy with the fields in a fixed order (the API's JSON does not keep one), so drafts compare. */
export const draftOf = (p: Draft): Draft => ({
  weights: { fit: p.weights.fit, intent: p.weights.intent, revenue: p.weights.revenue, trust: p.weights.trust },
  tier_cutoffs: { act_now: p.tier_cutoffs.act_now, good_fit: p.tier_cutoffs.good_fit, watch: p.tier_cutoffs.watch },
});

export const same = (a: Draft, b: Draft) => JSON.stringify(draftOf(a)) === JSON.stringify(draftOf(b));
