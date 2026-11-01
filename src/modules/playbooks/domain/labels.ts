// Who wrote each piece of a brief, in the API's words (Ruling 7).
import { AI_LABEL } from '@/modules/ai-tasks';
import type { BriefMode, BriefOrigin } from '../contracts/types';

export type WrittenBy = 'claude' | 'sample' | 'rules' | 'person';

export type LabelInput = { origin: BriefOrigin; mode: BriefMode | null; editedByName?: string | null };

export function writtenBy({ origin, mode }: LabelInput): WrittenBy {
  if (origin === 'human') return 'person';
  if (origin === 'rules' || mode === 'rules' || mode === null) return 'rules';
  return mode === 'live' ? 'claude' : 'sample';
}

/** `Written by Claude`, `Sample output`, `Assembled from rules` or `Edited by {name}`. */
export function labelFor(i: LabelInput): string {
  switch (writtenBy(i)) {
    case 'person':
      return `Edited by ${i.editedByName ?? 'a person'}`;
    case 'claude':
      return AI_LABEL.live;
    case 'sample':
      return AI_LABEL.mock;
    default:
      return AI_LABEL.rules;
  }
}
