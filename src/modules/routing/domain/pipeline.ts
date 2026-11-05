/** The workspace's pipeline stages and what moves an account between them (REV-E5). Pure: no database. */

/** "At most": the first stage only, the won stage only, one stage, or any number. */
export type TriggerLimit = 'first' | 'won' | 'one' | 'many';

export const TRIGGERS = [
  { key: 'source_creates', label: 'A source or import creates it', limit: 'first' },
  { key: 'reviewer_sets_tier', label: 'A reviewer sets a tier', limit: 'one' },
  { key: 'ae_accepts', label: 'An AE accepts the assignment', limit: 'one' },
  { key: 'reply_or_meeting', label: 'A reply or meeting is logged', limit: 'one' },
  { key: 'meeting_booked', label: 'A meeting is booked', limit: 'one' },
  { key: 'deal_created', label: 'A HubSpot deal is created', limit: 'one' },
  { key: 'deal_reaches_stage', label: 'HubSpot deal reaches this stage', limit: 'many' },
  { key: 'deal_closed_won', label: 'HubSpot deal is Closed won', limit: 'won' },
  { key: 'deal_closed_lost', label: 'HubSpot deal is Closed lost', limit: 'one' },
  { key: 'reviewer_rejects', label: 'A reviewer rejects it', limit: 'one' },
  { key: 'playbook_no_reply', label: 'Playbook ends with no reply', limit: 'one' },
  { key: 'by_hand', label: 'Set by hand', limit: 'many' },
] as const satisfies readonly { key: string; label: string; limit: TriggerLimit }[];
export type Trigger = (typeof TRIGGERS)[number]['key'];

export type PipelineStage = {
  key: string;
  name: string;
  description: string | null;
  kind: 'flow' | 'exit';
  /** Order within its kind. */
  position: number;
  trigger: Trigger;
  hubspotStage: string | null;
  quarterTarget: number | null;
  locked: 'first' | 'won' | null;
};

/** A stage as the editor sends it: no position (the order of the list), and no key for a new stage. */
export type PipelineStageInput = Pick<PipelineStage, 'name' | 'description' | 'kind' | 'trigger' | 'hubspotStage' | 'quarterTarget'> & { key?: string };

/** What an event means for stages. */
export type StageSignal =
  | { trigger: Trigger; hubspotStage?: string }
  | { kind: 'reopened' }
  | { kind: 'assignment_undone' }
  | { kind: 'by_hand'; to: string };

const flowStage = (key: string, name: string, trigger: Trigger, locked: PipelineStage['locked'] = null, hubspotStage: string | null = null): Omit<PipelineStage, 'position'> => ({
  key, name, description: null, kind: 'flow', trigger, hubspotStage, quarterTarget: null, locked,
});
const exitStage = (key: string, name: string, trigger: Trigger, hubspotStage: string | null = null): Omit<PipelineStage, 'position'> => ({
  key, name, description: null, kind: 'exit', trigger, hubspotStage, quarterTarget: null, locked: null,
});

/** Every workspace starts with these. Keys are the ones stages have always had, so stored data needs no rewrite. */
export const DEFAULT_STAGES: PipelineStage[] = [
  flowStage('arrived', 'Sent', 'source_creates', 'first'),
  flowStage('reviewed', 'Reviewed', 'reviewer_sets_tier'),
  flowStage('assigned', 'Assigned', 'ae_accepts'),
  flowStage('engaged', 'Engaged', 'reply_or_meeting'),
  flowStage('opportunity', 'Opportunity', 'deal_created'),
  flowStage('won', 'Won', 'deal_closed_won', 'won', 'closedwon'),
  exitStage('declined', 'Disqualified', 'reviewer_rejects'),
  exitStage('back_to_nurture', 'Back to nurture', 'playbook_no_reply'),
  exitStage('lost', 'Lost', 'deal_closed_lost', 'closedlost'),
].map((s, i) => ({ ...s, position: s.kind === 'flow' ? i : i - 6 }));

/** Triggers that mean an account has activity or a deal, which an undone assignment can't undo. */
const BEYOND_ACCEPTANCE: readonly Trigger[] = ['reply_or_meeting', 'meeting_booked', 'deal_created', 'deal_reaches_stage', 'deal_closed_won'];

const flowOf = (stages: readonly PipelineStage[]) => stages.filter((s) => s.kind === 'flow').sort((a, b) => a.position - b.position);
const furthest = (stages: PipelineStage[]) => stages.reduce<PipelineStage | null>((best, s) => (!best || s.position > best.position ? s : best), null);

/**
 * Where an account at `current` goes on `signals`, or null for no move (REV-E5 "Movement rules"). Flow
 * stages move forward only, to the furthest stage the signals fire; exits are entered from any flow stage
 * but the won one and left only by the listed returns or by hand.
 */
export function moveFor(current: string, signals: StageSignal[], stages: PipelineStage[]): string | null {
  for (const s of signals) {
    if ('kind' in s && s.kind === 'by_hand') return s.to !== current && stages.some((x) => x.key === s.to) ? s.to : null;
  }
  const cur = stages.find((s) => s.key === current);
  if (!cur) return null;
  const flow = flowOf(stages);
  const first = flow.find((s) => s.locked === 'first') ?? flow[0];

  for (const s of signals) {
    if (!('kind' in s)) continue;
    if (s.kind === 'reopened') return cur.kind === 'exit' && cur.trigger === 'reviewer_rejects' && first ? first.key : null;
    if (s.kind === 'assignment_undone') {
      const accepts = flow.find((x) => x.trigger === 'ae_accepts');
      if (!accepts || cur.kind !== 'flow' || cur.position < accepts.position) return null;
      const end = flow.find((x) => x.position > accepts.position && BEYOND_ACCEPTANCE.includes(x.trigger));
      if (end && cur.position >= end.position) return null;
      const back = flow.find((x) => x.trigger === 'reviewer_sets_tier') ?? first;
      return back && back.position < cur.position ? back.key : null;
    }
  }

  const fired = stages.filter((x) =>
    signals.some((s) => 'trigger' in s && s.trigger === x.trigger && (x.trigger !== 'deal_reaches_stage' || (!!x.hubspotStage && x.hubspotStage === s.hubspotStage))),
  );
  if (cur.kind === 'exit') {
    // An account sent to nurture by a playbook with no reply comes back on a later reply, meeting or deal (R2c-3b).
    if (cur.trigger === 'playbook_no_reply') return furthest(fired.filter((x) => x.kind === 'flow' && BEYOND_ACCEPTANCE.includes(x.trigger)))?.key ?? null;
    // A new open deal reopens an account lost with its last one.
    if (cur.trigger !== 'deal_closed_lost') return null;
    return furthest(fired.filter((x) => x.kind === 'flow' && (x.trigger === 'deal_created' || x.trigger === 'deal_reaches_stage')))?.key ?? null;
  }
  const ahead = furthest(fired.filter((x) => x.kind === 'flow' && x.position > cur.position));
  if (ahead) return ahead.key;
  if (cur.locked === 'won') return null;
  const exit = fired.find((x) => x.kind === 'exit');
  // A playbook that ends with no reply never pulls back an account that has replied, met or has a deal.
  if (exit?.trigger === 'playbook_no_reply') {
    const end = flow.find((x) => BEYOND_ACCEPTANCE.includes(x.trigger));
    if (end && cur.position >= end.position) return null;
  }
  return exit?.key ?? null;
}

/** The label with its first letter lowercased, to sit in a sentence ("an AE accepts...", "HubSpot deal..." as is). */
const inSentence = (label: string) => label.replace(/^(?!HubSpot)([A-Z])/, (c) => c.toLowerCase());

export const FIRST_AND_WON_SENTENCE = 'The first stage and the won stage can be renamed but not deleted.';

/** The problems with a saved list, each with the field it belongs to; empty when the list is fine (REV-E5 "Editing"). */
export function validateStages(next: PipelineStageInput[], prev: PipelineStage[], archivedKeys: string[] = []): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });
  // A deleted stage may come back under its key (Restore defaults); a key is listed once.
  const prevKeys = new Set([...prev.map((s) => s.key), ...archivedKeys]);
  const seenKeys = new Set<string>();

  const names = new Set<string>();
  next.forEach((s, i) => {
    const name = s.name.trim().toLowerCase();
    if (!name) add(`stages.${i}.name`, 'Every stage needs a name.');
    else if (names.has(name)) add(`stages.${i}.name`, "Two stages can't share a name.");
    names.add(name);
    if (s.key && !prevKeys.has(s.key)) add(`stages.${i}.key`, "That stage doesn't exist.");
    else if (s.key && seenKeys.has(s.key)) add(`stages.${i}.key`, 'That stage is in the list twice.');
    if (s.key) seenKeys.add(s.key);
    if (s.trigger === 'deal_reaches_stage' && !s.hubspotStage?.trim()) add(`stages.${i}.hubspotStage`, 'A stage that moves on a HubSpot deal stage needs that HubSpot stage.');
    if (s.kind === 'exit' && s.quarterTarget != null) add(`stages.${i}.quarterTarget`, "Exits don't have a quarter target.");
    else if (s.quarterTarget != null && !(Number.isInteger(s.quarterTarget) && s.quarterTarget >= 0)) add(`stages.${i}.quarterTarget`, 'Quarter targets are whole numbers, 0 or more.');
  });

  for (const t of TRIGGERS) {
    if (t.limit === 'many') continue;
    next.forEach((s, i) => {
      if (s.trigger !== t.key) return;
      if (next.findIndex((x) => x.trigger === t.key) !== i) add(`stages.${i}.trigger`, `Only one stage can move when ${inSentence(t.label)}.`);
    });
  }

  const flowIdx = next.map((s, i) => (s.kind === 'flow' ? i : -1)).filter((i) => i >= 0);
  for (const locked of prev.filter((s) => s.locked)) {
    const i = next.findIndex((s) => s.key === locked.key);
    if (i < 0) {
      add('stages', FIRST_AND_WON_SENTENCE);
      continue;
    }
    const s = next[i]!;
    if (s.kind !== 'flow') add(`stages.${i}.kind`, `The ${locked.locked} stage has to stay a stage, not an exit.`);
    else if (flowIdx[locked.locked === 'first' ? 0 : flowIdx.length - 1] !== i) add(`stages.${i}`, locked.locked === 'first' ? 'The first stage has to stay first.' : 'The won stage has to stay last.');
    if (s.trigger !== locked.trigger) add(`stages.${i}.trigger`, `The ${locked.locked} stage keeps its trigger.`);
  }
  return errors;
}

/** Where accounts on deleted stages go (REV-E5 "Deleting a stage"). `history` is the account's earlier stage keys, newest first. */
export function planDeletion(prev: PipelineStage[], next: PipelineStageInput[]): { archived: string[]; moveTo: (key: string, history: string[]) => string } {
  const live = new Set(next.flatMap((s) => (s.key ? [s.key] : [])));
  const archived = prev.filter((s) => !live.has(s.key)).map((s) => s.key);
  const flow = flowOf(prev);
  const first = (flow.find((s) => s.locked === 'first') ?? flow[0])!.key;
  return {
    archived,
    moveTo(key, history) {
      const gone = prev.find((s) => s.key === key);
      if (gone?.kind === 'flow') return [...flow].reverse().find((s) => s.position < gone.position && live.has(s.key))?.key ?? first;
      return history.find((k) => live.has(k)) ?? first;
    },
  };
}

/** Sort rank per stage key for `stage_priority`: flow stages in order, then exits. */
export function stageRank(stages: PipelineStage[]): Map<string, number> {
  const flow = flowOf(stages);
  const exits = stages.filter((s) => s.kind === 'exit').sort((a, b) => a.position - b.position);
  return new Map([...flow, ...exits].map((s, i) => [s.key, i]));
}
