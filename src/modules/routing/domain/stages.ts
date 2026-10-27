import type { Stage } from '../contracts/types';

/** What can move a stage (REV-E4, with Ruling 16). */
export type StageEvent =
  | 'reviewed' // status changed to one that counts as reviewed and is not declined
  | 'declined' // status changed to a declined one
  | 'reopened' // a declined account reopened
  | 'assigned' // assignment accepted
  | 'assignment_declined' // seller declined
  | 'withdrawn' // assignment withdrawn
  | 'engaged'
  | 'opportunity'
  | 'won'
  | 'lost';

const FUNNEL = ['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won'] as const;
const rank = (s: Stage): number => FUNNEL.indexOf(s as (typeof FUNNEL)[number]);

/** Moves forward to `to` from any earlier funnel stage; exits (lost, declined) and later stages stay put. */
const forwardTo = (current: Stage, to: Stage): Stage | null => {
  const from = rank(current);
  return from >= 0 && from < rank(to) ? to : null;
};

/** The stage after `event`, or null when nothing moves. Stages only move forward except the listed returns. */
export function nextStage(current: Stage, event: StageEvent): Stage | null {
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
