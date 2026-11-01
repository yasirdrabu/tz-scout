import type { Stage } from '../contracts/types';
import { DEFAULT_STAGES, moveFor, type StageSignal } from './pipeline';

/** What can move a stage (REV-E4, with Ruling 16). */
export type StageEvent =
  | 'reviewed' // status changed to one that counts as reviewed and is not declined
  | 'declined' // status changed to a declined one
  | 'reopened' // a declined account reopened
  | 'assigned' // assignment accepted
  | 'assignment_declined' // seller declined
  | 'withdrawn' // assignment withdrawn
  | 'engaged' // a reply
  | 'meeting' // a meeting: also fires `meeting_booked`
  | 'opportunity'
  | 'won'
  | 'lost';

const FUNNEL = ['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won'] as const;

/** What an event means for the workspace's stages (REV-E5 "Triggers"). */
export function eventSignals(event: StageEvent): StageSignal[] {
  switch (event) {
    case 'reviewed':
      return [{ trigger: 'reviewer_sets_tier' }];
    case 'declined':
      return [{ trigger: 'reviewer_rejects' }];
    case 'reopened':
      return [{ kind: 'reopened' }];
    case 'assigned':
      return [{ trigger: 'ae_accepts' }];
    case 'assignment_declined':
    case 'withdrawn':
      return [{ kind: 'assignment_undone' }];
    case 'engaged':
      return [{ trigger: 'reply_or_meeting' }];
    case 'meeting':
      return [{ trigger: 'reply_or_meeting' }, { trigger: 'meeting_booked' }];
    case 'opportunity':
      return [{ trigger: 'deal_created' }];
    case 'won':
      return [{ trigger: 'deal_closed_won' }];
    case 'lost':
      return [{ trigger: 'deal_closed_lost' }];
  }
}

/** The stage after `event` with the default stages (REV-E4's rule, now `moveFor`), or null when nothing moves. */
export const nextStage = (current: Stage, event: StageEvent): Stage | null => moveFor(current, eventSignals(event), DEFAULT_STAGES);

/** The pipeline stages in order, then the exits, with the names people see (C6, until stages are configurable, Decision 6). */
export const STAGE_LABELS: Record<Stage, string> = {
  arrived: 'Arrived',
  reviewed: 'Reviewed',
  assigned: 'Assigned',
  engaged: 'Engaged',
  opportunity: 'Opportunity',
  won: 'Won',
  lost: 'Lost',
  declined: 'Not pursued',
  back_to_nurture: 'Back to nurture',
};
export const PIPELINE_STAGES = FUNNEL;
/** Exits: what All accounts' "Other" tab holds, with the accounts sent back to their source. */
export const EXIT_STAGES = ['lost', 'declined'] as const;
