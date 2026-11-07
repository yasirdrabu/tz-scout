/** Step types, in the order the What worked rows are shown (the playbook step channels). */
export const STEP_CHANNELS = ['email', 'linkedin', 'call', 'meeting', 'task'] as const;
export type StepChannel = (typeof STEP_CHANNELS)[number];

/** Fewer steps done than this and a per-10 figure is too thin to compare. */
export const MIN_STEPS = 10;

export type Counts = { reply: number; meeting: number; opportunity: number; won: number };
export type WhatWorkedRow = {
  stepType: StepChannel;
  stepsDone: number;
  counts: Counts;
  per10: { [K in keyof Counts]: number | null };
};
export type WhatWorked = { rows: WhatWorkedRow[]; noRecentStep: Counts; minSteps: typeof MIN_STEPS };

const COUNTED = ['reply', 'meeting', 'opportunity', 'won'] as const;
const zero = (): Counts => ({ reply: 0, meeting: 0, opportunity: 0, won: 0 });
const isCounted = (k: string): k is keyof Counts => (COUNTED as readonly string[]).includes(k);

/**
 * Credits (one per credited step per outcome) and the steps done, both already in the window and the data limit
 * (Ruling 9). Lost and no_response are not counted; a channel with no steps done and no results is left out;
 * per 10 is `round(count / stepsDone * 10, 1)`, null with no steps done.
 */
export function rollUp(credits: { outcomeKind: string; stepType: string | null }[], doneSteps: { channel: string }[]): WhatWorked {
  const byChannel = new Map<string, { stepsDone: number; counts: Counts }>();
  const slot = (c: string) => byChannel.get(c) ?? byChannel.set(c, { stepsDone: 0, counts: zero() }).get(c)!;
  for (const s of doneSteps) slot(s.channel).stepsDone += 1;
  const noRecentStep = zero();
  for (const c of credits) {
    if (!isCounted(c.outcomeKind)) continue;
    (c.stepType === null ? noRecentStep : slot(c.stepType).counts)[c.outcomeKind] += 1;
  }
  const per10 = (n: number, steps: number) => (steps === 0 ? null : Math.round((n / steps) * 100) / 10);
  const rows = STEP_CHANNELS.flatMap((stepType): WhatWorkedRow[] => {
    const s = byChannel.get(stepType);
    if (!s || (s.stepsDone === 0 && COUNTED.every((k) => s.counts[k] === 0))) return [];
    return [
      {
        stepType,
        stepsDone: s.stepsDone,
        counts: s.counts,
        per10: {
          reply: per10(s.counts.reply, s.stepsDone),
          meeting: per10(s.counts.meeting, s.stepsDone),
          opportunity: per10(s.counts.opportunity, s.stepsDone),
          won: per10(s.counts.won, s.stepsDone),
        },
      },
    ];
  });
  return { rows, noRecentStep, minSteps: MIN_STEPS };
}
