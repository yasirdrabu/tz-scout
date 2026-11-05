import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STAGES,
  moveFor,
  planDeletion,
  stageRank,
  TRIGGERS,
  validateStages,
  type PipelineStage,
  type PipelineStageInput,
  type StageSignal,
  type Trigger,
} from '@/modules/routing/domain/pipeline';

// The REV-E4 rule, frozen as it was before stages became configurable (the old `nextStage`), as the oracle.
type LegacyEvent = 'reviewed' | 'declined' | 'reopened' | 'assigned' | 'assignment_declined' | 'withdrawn' | 'engaged' | 'opportunity' | 'won' | 'lost';
const FUNNEL = ['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won'];
const rank = (s: string) => FUNNEL.indexOf(s);
const forwardTo = (current: string, to: string) => (rank(current) >= 0 && rank(current) < rank(to) ? to : null);
function legacyNextStage(current: string, event: LegacyEvent): string | null {
  switch (event) {
    case 'reviewed':
    case 'assigned':
    case 'engaged':
    case 'won':
      return forwardTo(current, event);
    case 'opportunity':
      return current === 'lost' ? 'opportunity' : forwardTo(current, 'opportunity');
    case 'lost':
      return rank(current) >= 0 && current !== 'won' ? 'lost' : null;
    case 'declined':
      return rank(current) >= 0 && current !== 'won' ? 'declined' : null;
    case 'reopened':
      return current === 'declined' ? 'arrived' : null;
    case 'assignment_declined':
    case 'withdrawn':
      return current === 'assigned' ? 'reviewed' : null;
  }
}

/** What each old event means for stages (the REV-E5 Triggers table). */
const SIGNALS: Record<LegacyEvent, StageSignal[]> = {
  reviewed: [{ trigger: 'reviewer_sets_tier' }],
  declined: [{ trigger: 'reviewer_rejects' }],
  reopened: [{ kind: 'reopened' }],
  assigned: [{ trigger: 'ae_accepts' }],
  assignment_declined: [{ kind: 'assignment_undone' }],
  withdrawn: [{ kind: 'assignment_undone' }],
  engaged: [{ trigger: 'reply_or_meeting' }],
  opportunity: [{ trigger: 'deal_created' }],
  won: [{ trigger: 'deal_closed_won' }],
  lost: [{ trigger: 'deal_closed_lost' }],
};

const sig = (...triggers: Trigger[]): StageSignal[] => triggers.map((trigger) => ({ trigger }));
const keys = DEFAULT_STAGES.map((s) => s.key);

describe('REV-E4 equivalence: with the default stages moveFor does what nextStage did', () => {
  const cases = (Object.keys(SIGNALS) as LegacyEvent[]).flatMap((event) => keys.map((stage) => [event, stage] as const));
  it.each(cases)('%s at %s', (event, stage) => {
    expect(moveFor(stage, SIGNALS[event], DEFAULT_STAGES)).toBe(legacyNextStage(stage, event));
  });
  it('a meeting (reply_or_meeting and meeting_booked) is an engaged event', () => {
    for (const stage of keys) expect(moveFor(stage, sig('reply_or_meeting', 'meeting_booked'), DEFAULT_STAGES)).toBe(legacyNextStage(stage, 'engaged'));
  });
});

describe('defaults', () => {
  it('are REV-E5 "Defaults", flow then exits', () => {
    expect(DEFAULT_STAGES.map((s) => [s.key, s.name, s.kind, s.position, s.trigger, s.hubspotStage, s.locked])).toEqual([
      ['arrived', 'Sent', 'flow', 0, 'source_creates', null, 'first'],
      ['reviewed', 'Reviewed', 'flow', 1, 'reviewer_sets_tier', null, null],
      ['assigned', 'Assigned', 'flow', 2, 'ae_accepts', null, null],
      ['engaged', 'Engaged', 'flow', 3, 'reply_or_meeting', null, null],
      ['opportunity', 'Opportunity', 'flow', 4, 'deal_created', null, null],
      ['won', 'Won', 'flow', 5, 'deal_closed_won', 'closedwon', 'won'],
      ['declined', 'Disqualified', 'exit', 0, 'reviewer_rejects', null, null],
      ['back_to_nurture', 'Back to nurture', 'exit', 1, 'playbook_no_reply', null, null],
      ['lost', 'Lost', 'exit', 2, 'deal_closed_lost', 'closedlost', null],
    ]);
  });
  it('lists the twelve triggers with their limits', () => {
    expect(TRIGGERS).toHaveLength(12);
    expect(TRIGGERS.find((t) => t.key === 'ae_accepts')).toEqual({ key: 'ae_accepts', label: 'An AE accepts the assignment', limit: 'one' });
    expect(TRIGGERS.find((t) => t.key === 'source_creates')?.limit).toBe('first');
    expect(TRIGGERS.find((t) => t.key === 'deal_closed_won')?.limit).toBe('won');
    expect(TRIGGERS.filter((t) => t.limit === 'many').map((t) => t.key)).toEqual(['deal_reaches_stage', 'by_hand']);
  });
});

const stage = (over: Partial<PipelineStage> & Pick<PipelineStage, 'key' | 'position'>): PipelineStage => ({
  name: over.key,
  description: null,
  kind: 'flow',
  trigger: 'by_hand',
  hubspotStage: null,
  quarterTarget: null,
  locked: null,
  ...over,
});
/** The defaults with `extra` inserted as a flow stage at `position`, later flow stages pushed down. */
const inserted = (extra: PipelineStage): PipelineStage[] => [
  ...DEFAULT_STAGES.filter((s) => s.kind === 'flow' && s.position < extra.position),
  extra,
  ...DEFAULT_STAGES.filter((s) => s.kind === 'flow' && s.position >= extra.position).map((s) => ({ ...s, position: s.position + 1 })),
  ...DEFAULT_STAGES.filter((s) => s.kind === 'exit'),
];
/** The defaults with the reply trigger moved off Engaged onto a new "Talking" stage after it (REV-E5-S2-AC2). */
const withTalking = (): PipelineStage[] =>
  inserted(stage({ key: 'stg_talking', position: 4, trigger: 'reply_or_meeting' })).map((s) => (s.key === 'engaged' ? { ...s, trigger: 'by_hand' as const } : s));

describe('movement rules', () => {
  it('REV-E5-S2-AC2: the next reply moves the account to the stage that now owns the trigger', () => {
    expect(moveFor('assigned', sig('reply_or_meeting'), withTalking())).toBe('stg_talking');
    expect(moveFor('engaged', sig('reply_or_meeting'), withTalking())).toBe('stg_talking');
  });
  it('REV-E5-S2-AC3: no stage fires the trigger, nothing moves', () => {
    const noReply = DEFAULT_STAGES.filter((s) => s.trigger !== 'reply_or_meeting');
    expect(moveFor('assigned', sig('reply_or_meeting'), noReply)).toBeNull();
    expect(moveFor('assigned', sig('meeting_booked'), DEFAULT_STAGES)).toBeNull();
  });
  it('REV-E5-S2-AC4: never back on an event', () => {
    expect(moveFor('opportunity', sig('reply_or_meeting'), DEFAULT_STAGES)).toBeNull();
    expect(moveFor('opportunity', sig('reply_or_meeting'), withTalking())).toBeNull();
  });
  it('one event firing several stages takes the furthest flow stage', () => {
    const stages = DEFAULT_STAGES.map((s) => (s.key === 'opportunity' ? { ...s, trigger: 'meeting_booked' as const } : s));
    expect(moveFor('assigned', sig('reply_or_meeting', 'meeting_booked'), stages)).toBe('opportunity');
    expect(moveFor('assigned', sig('reply_or_meeting'), stages)).toBe('engaged');
  });
  it('exits are entered from any flow stage but the won stage', () => {
    for (const from of ['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity']) expect(moveFor(from, sig('deal_closed_lost'), DEFAULT_STAGES)).toBe('lost');
    // A playbook ending with no reply stops short of an account that has engaged.
    for (const from of ['arrived', 'reviewed', 'assigned']) expect(moveFor(from, sig('playbook_no_reply'), DEFAULT_STAGES)).toBe('back_to_nurture');
    expect(moveFor('won', sig('deal_closed_lost'), DEFAULT_STAGES)).toBeNull();
    expect(moveFor('won', sig('reviewer_rejects'), DEFAULT_STAGES)).toBeNull();
  });
  it('an account in an exit stays there on other events', () => {
    expect(moveFor('lost', sig('reply_or_meeting'), DEFAULT_STAGES)).toBeNull();
    expect(moveFor('back_to_nurture', sig('ae_accepts'), DEFAULT_STAGES)).toBeNull();
    expect(moveFor('declined', sig('deal_closed_lost'), DEFAULT_STAGES)).toBeNull();
  });
  it('reopening a rejected account goes to the first stage', () => {
    expect(moveFor('declined', [{ kind: 'reopened' }], DEFAULT_STAGES)).toBe('arrived');
    expect(moveFor('lost', [{ kind: 'reopened' }], DEFAULT_STAGES)).toBeNull();
  });
  it('a new open deal takes an account out of the closed-lost exit', () => {
    expect(moveFor('lost', sig('deal_created'), DEFAULT_STAGES)).toBe('opportunity');
    expect(moveFor('declined', sig('deal_created'), DEFAULT_STAGES)).toBeNull();
  });
  it('an undone assignment goes back to the reviewer_sets_tier stage, else the first', () => {
    expect(moveFor('assigned', [{ kind: 'assignment_undone' }], DEFAULT_STAGES)).toBe('reviewed');
    expect(moveFor('engaged', [{ kind: 'assignment_undone' }], DEFAULT_STAGES)).toBeNull();
    expect(moveFor('reviewed', [{ kind: 'assignment_undone' }], DEFAULT_STAGES)).toBeNull();
    const noTier = DEFAULT_STAGES.filter((s) => s.key !== 'reviewed');
    expect(moveFor('assigned', [{ kind: 'assignment_undone' }], noTier)).toBe('arrived');
  });
  it('an undone assignment also pulls back a hand-set stage between acceptance and the first activity or deal stage', () => {
    const stages = inserted(stage({ key: 'stg_briefed', position: 3 }));
    expect(moveFor('stg_briefed', [{ kind: 'assignment_undone' }], stages)).toBe('reviewed');
    expect(moveFor('engaged', [{ kind: 'assignment_undone' }], stages)).toBeNull();
  });
  it('by hand moves anywhere live, forward or back, into or out of an exit', () => {
    expect(moveFor('lost', [{ kind: 'by_hand', to: 'opportunity' }], DEFAULT_STAGES)).toBe('opportunity');
    expect(moveFor('won', [{ kind: 'by_hand', to: 'reviewed' }], DEFAULT_STAGES)).toBe('reviewed');
    expect(moveFor('engaged', [{ kind: 'by_hand', to: 'lost' }], DEFAULT_STAGES)).toBe('lost');
    expect(moveFor('engaged', [{ kind: 'by_hand', to: 'engaged' }], DEFAULT_STAGES)).toBeNull();
    expect(moveFor('engaged', [{ kind: 'by_hand', to: 'stg_gone' }], DEFAULT_STAGES)).toBeNull();
  });
  it('a deal reaching a HubSpot stage moves to the stage mapped to it, forward only', () => {
    const stages = inserted(stage({ key: 'stg_proposal', position: 5, trigger: 'deal_reaches_stage', hubspotStage: 'presentationscheduled' }));
    const reaches: StageSignal[] = [{ trigger: 'deal_reaches_stage', hubspotStage: 'presentationscheduled' }];
    expect(moveFor('opportunity', reaches, stages)).toBe('stg_proposal');
    expect(moveFor('opportunity', [{ trigger: 'deal_reaches_stage', hubspotStage: 'other' }], stages)).toBeNull();
    expect(moveFor('won', reaches, stages)).toBeNull();
  });
  it('a playbook ending with no reply moves an accepted account to the exit, never one that engaged or went further', () => {
    const noReply: StageSignal[] = [{ trigger: 'playbook_no_reply' }];
    expect(moveFor('assigned', noReply, DEFAULT_STAGES)).toBe('back_to_nurture');
    expect(moveFor('reviewed', noReply, DEFAULT_STAGES)).toBe('back_to_nurture');
    expect(moveFor('engaged', noReply, DEFAULT_STAGES)).toBeNull();
    expect(moveFor('opportunity', noReply, DEFAULT_STAGES)).toBeNull();
    expect(moveFor('won', noReply, DEFAULT_STAGES)).toBeNull();
    expect(moveFor('declined', noReply, DEFAULT_STAGES)).toBeNull();
  });
  it('a hand-set stage past the first reply or meeting stage does not go back to nurture, whatever its trigger', () => {
    const stages = inserted(stage({ key: 'stg_demo', position: 5 }));
    expect(moveFor('stg_demo', [{ trigger: 'playbook_no_reply' }], stages)).toBeNull();
  });
  it('with no stage past acceptance, a playbook ending with no reply moves from any flow stage but Won', () => {
    const bare = DEFAULT_STAGES.filter((s) => !['engaged', 'opportunity'].includes(s.key)).map((s) => (s.key === 'won' ? { ...s, trigger: 'by_hand' as const } : s));
    expect(moveFor('assigned', [{ trigger: 'playbook_no_reply' }], bare)).toBe('back_to_nurture');
    expect(moveFor('arrived', [{ trigger: 'playbook_no_reply' }], bare)).toBe('back_to_nurture');
    expect(moveFor('won', [{ trigger: 'playbook_no_reply' }], bare)).toBeNull();
  });
  it('an archived or unknown current stage only moves by hand', () => {
    expect(moveFor('stg_old', sig('ae_accepts'), DEFAULT_STAGES)).toBeNull();
    expect(moveFor('stg_old', [{ kind: 'by_hand', to: 'reviewed' }], DEFAULT_STAGES)).toBe('reviewed');
  });
});

const toInput = (stages: readonly PipelineStage[]): PipelineStageInput[] =>
  stages.map(({ key, name, description, kind, trigger, hubspotStage, quarterTarget }) => ({ key, name, description, kind, trigger, hubspotStage, quarterTarget }));
const NEW: Omit<PipelineStageInput, 'name'> = { description: null, kind: 'flow', trigger: 'by_hand', hubspotStage: null, quarterTarget: null };

describe('validateStages', () => {
  const messages = (next: PipelineStageInput[]) => validateStages(next, DEFAULT_STAGES).map((e) => e.message);

  it('accepts the defaults', () => expect(validateStages(toInput(DEFAULT_STAGES), DEFAULT_STAGES)).toEqual([]));
  it('Every stage needs a name.', () => {
    const next = toInput(DEFAULT_STAGES);
    next[3]!.name = '  ';
    expect(validateStages(next, DEFAULT_STAGES)).toEqual([{ path: 'stages.3.name', message: 'Every stage needs a name.' }]);
  });
  it("Two stages can't share a name.", () => {
    const next = toInput(DEFAULT_STAGES);
    next[3]!.name = 'reviewed ';
    expect(validateStages(next, DEFAULT_STAGES)).toEqual([{ path: 'stages.3.name', message: "Two stages can't share a name." }]);
  });
  it('The first stage and the won stage can be renamed but not deleted.', () => {
    const sentence = 'The first stage and the won stage can be renamed but not deleted.';
    expect(messages(toInput(DEFAULT_STAGES).filter((s) => s.key !== 'won'))).toContain(sentence);
    expect(messages(toInput(DEFAULT_STAGES).filter((s) => s.key !== 'arrived'))).toContain(sentence);
    const renamed = toInput(DEFAULT_STAGES);
    renamed[5]!.name = 'Closed won';
    expect(validateStages(renamed, DEFAULT_STAGES)).toEqual([]);
  });
  it('Only one stage can move when an AE accepts the assignment. (REV-E5-S1-AC5)', () => {
    const next = toInput(DEFAULT_STAGES);
    next[3]!.trigger = 'ae_accepts';
    expect(validateStages(next, DEFAULT_STAGES)).toEqual([{ path: 'stages.3.trigger', message: 'Only one stage can move when an AE accepts the assignment.' }]);
  });
  it('lowercases the first word of the label, but not HubSpot', () => {
    const next = toInput(DEFAULT_STAGES);
    next[8]!.trigger = 'reviewer_rejects';
    expect(messages(next)).toEqual(['Only one stage can move when a reviewer rejects it.']);
    const won = toInput(DEFAULT_STAGES);
    won[3]!.trigger = 'deal_closed_won';
    expect(messages(won)).toEqual(['Only one stage can move when HubSpot deal is Closed won.']);
  });
  it('A stage that moves on a HubSpot deal stage needs that HubSpot stage.', () => {
    const next = toInput(DEFAULT_STAGES);
    next[3]!.trigger = 'deal_reaches_stage';
    expect(validateStages(next, DEFAULT_STAGES)).toEqual([{ path: 'stages.3.hubspotStage', message: 'A stage that moves on a HubSpot deal stage needs that HubSpot stage.' }]);
    next[3]!.hubspotStage = 'qualified';
    expect(validateStages(next, DEFAULT_STAGES)).toEqual([]);
  });
  it('keeps the first stage first and the won stage last, with their triggers', () => {
    const swapped = toInput(DEFAULT_STAGES);
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(messages(swapped).length).toBeGreaterThan(0);
    const retriggered = toInput(DEFAULT_STAGES);
    retriggered[5]!.trigger = 'by_hand';
    expect(messages(retriggered).length).toBeGreaterThan(0);
  });
  it('no target on an exit; targets are whole numbers of 0 or more', () => {
    const exit = toInput(DEFAULT_STAGES);
    exit[7]!.quarterTarget = 5;
    expect(messages(exit)).toHaveLength(1);
    for (const bad of [-1, 1.5]) {
      const next = toInput(DEFAULT_STAGES);
      next[3]!.quarterTarget = bad;
      expect(messages(next)).toHaveLength(1);
    }
    const ok = toInput(DEFAULT_STAGES);
    ok[3]!.quarterTarget = 0;
    expect(validateStages(ok, DEFAULT_STAGES)).toEqual([]);
  });
  it('That stage is in the list twice.', () => {
    const next = toInput(DEFAULT_STAGES);
    next.splice(4, 0, { ...next[3]!, name: 'Talking again', trigger: 'by_hand' });
    expect(validateStages(next, DEFAULT_STAGES)).toEqual([{ path: 'stages.4.key', message: 'That stage is in the list twice.' }]);
    const firstAgain = toInput(DEFAULT_STAGES);
    firstAgain.splice(1, 0, { ...firstAgain[0]!, name: 'Sent twice' });
    expect(messages(firstAgain)).toContain('That stage is in the list twice.');
    const wonAgain = toInput(DEFAULT_STAGES);
    wonAgain.splice(5, 0, { ...wonAgain[5]!, name: 'Won twice' });
    expect(messages(wonAgain)).toContain('That stage is in the list twice.');
  });
  it('treats a missing quarter target as none, on a stage and on an exit', () => {
    const next = toInput(DEFAULT_STAGES);
    for (const s of next) delete (s as { quarterTarget?: number | null }).quarterTarget;
    expect(validateStages(next, DEFAULT_STAGES)).toEqual([]);
  });
  it('accepts a deleted default stage coming back under its key', () => {
    const prev = DEFAULT_STAGES.filter((s) => s.key !== 'engaged');
    expect(validateStages(toInput(DEFAULT_STAGES), prev, ['engaged'])).toEqual([]);
    expect(validateStages(toInput(DEFAULT_STAGES), prev)).toEqual([{ path: 'stages.3.key', message: "That stage doesn't exist." }]);
  });
  it('allows many stages on "Set by hand"', () => {
    const next = toInput(DEFAULT_STAGES);
    next.splice(5, 0, { ...NEW, name: 'Proposal' }, { ...NEW, name: 'Contract' });
    expect(validateStages(next, DEFAULT_STAGES)).toEqual([]);
  });
});

describe('planDeletion', () => {
  const without = (...drop: string[]) => toInput(DEFAULT_STAGES.filter((s) => !drop.includes(s.key)));

  it('archives what the new list leaves out', () => {
    expect(planDeletion(DEFAULT_STAGES, without('engaged', 'lost')).archived).toEqual(['engaged', 'lost']);
    expect(planDeletion(DEFAULT_STAGES, without()).archived).toEqual([]);
  });
  it('a deleted flow stage sends its accounts to the previous flow stage that is left (REV-E5-S1-AC3)', () => {
    expect(planDeletion(DEFAULT_STAGES, without('engaged')).moveTo('engaged', [])).toBe('assigned');
    expect(planDeletion(DEFAULT_STAGES, without('assigned', 'engaged')).moveTo('engaged', [])).toBe('reviewed');
  });
  it('a deleted exit sends its accounts to the live stage they were at before, else the first', () => {
    const plan = planDeletion(DEFAULT_STAGES, without('lost'));
    expect(plan.moveTo('lost', ['opportunity', 'engaged'])).toBe('opportunity');
    expect(plan.moveTo('lost', [])).toBe('arrived');
    expect(planDeletion(DEFAULT_STAGES, without('lost', 'opportunity')).moveTo('lost', ['opportunity', 'engaged'])).toBe('engaged');
  });
});

describe('stageRank', () => {
  it('ranks flow by position, then exits', () => {
    const r = stageRank(DEFAULT_STAGES);
    expect(keys.map((k) => r.get(k))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
