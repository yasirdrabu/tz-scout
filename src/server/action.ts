// Server action plumbing: every action returns an ActionResult instead of throwing, so forms can
// show plain-language errors inline.

import { revalidatePath } from 'next/cache';
import { ScoutError } from '@/platform/errors';
import { log } from '@/platform/log';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };
export type FormAction = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

export async function act(
  fn: () => Promise<unknown>,
  opts: { revalidate?: string; message?: string } = {},
): Promise<ActionResult> {
  try {
    await fn();
    if (opts.revalidate) revalidatePath(opts.revalidate, 'layout');
    return { ok: true, message: opts.message };
  } catch (e) {
    if (e && typeof e === 'object' && 'digest' in e && String((e as { digest: unknown }).digest).startsWith('NEXT_')) {
      throw e;
    }
    if (e instanceof ScoutError) return { ok: false, error: e.detail ?? e.message };
    log.error({ err: e }, 'server action failed');
    return { ok: false, error: 'Something went wrong. Try again in a minute.' };
  }
}

export const str = (fd: FormData, k: string): string => {
  const v = fd.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
