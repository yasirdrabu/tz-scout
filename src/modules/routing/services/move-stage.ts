import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import type { ModuleContext } from '@/platform/context';
import type { ReviewSnapshot } from '../contracts/types';
import { checkLength, lockForWrite, requirePerson } from './review';
import { loadStages } from './pipeline-stages';
import { currentReviewSnapshot, publishReviewSnapshot } from './snapshot';
import { moveStage } from './stage';

/**
 * `Move to stage` (REV-E5-S4): a person puts an account in any live stage of the workspace, forward or
 * back, into or out of an exit. History keeps who moved it and the note. Moving to the stage it is in
 * writes nothing.
 */
export async function moveToStage(ctx: ModuleContext, accountId: string, input: { stage: string; note?: string | null }): Promise<ReviewSnapshot> {
  const by = requirePerson(ctx);
  const note = input.note?.trim() || null;
  checkLength(note, 'note');
  await lockForWrite(ctx, accountId);
  if (!(await loadStages(ctx)).some((s) => s.key === input.stage)) {
    const title = 'Pick a stage from your list.';
    throw new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path: 'stage', message: title }] });
  }
  const moved = await moveStage(ctx, accountId, [{ kind: 'by_hand', to: input.stage }], newId('evt'), { by, note });
  return moved ? publishReviewSnapshot(ctx, accountId) : currentReviewSnapshot(ctx, accountId);
}
