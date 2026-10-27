import type { PersonView } from '@/modules/accounts';
import { getArrival, type InlineResult, type SubmitResult } from '@/modules/intake';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { created, type StatusResult } from '../_lib/v1-route';

/** TEN-E3-S3-AC1: without people:read a person has no email, phone, mobile phone or LinkedIn page. */
export function personFor(p: PersonView, canReadPeople: boolean): Partial<PersonView> {
  if (canReadPeople) return p;
  const { email: _e, phone: _p, mobilePhone: _m, linkedinUrl: _l, ...rest } = p;
  return rest;
}

/** The fact keys that hold a person's contact details. */
export const CONTACT_KEYS = new Set(['email', 'phone', 'mobile_phone', 'linkedin_url']);

/** The arrival's id and status; a rejected one (the account is excluded) also says why, as the arrival row stores it. */
export async function arrivalOutcome(ctx: ModuleContext, r: Pick<SubmitResult, 'arrivalId' | 'status'>) {
  if (r.status !== 'rejected') return { arrivalId: r.arrivalId, status: r.status };
  return { arrivalId: r.arrivalId, status: r.status, reason: (await getArrival(ctx, r.arrivalId))?.reason ?? null };
}

/** 201 with `reply(result)`. A rejected arrival keeps what it stored and adds its status and reason. */
export async function inlineReply(ctx: ModuleContext, r: SubmitResult, reply: (x: InlineResult) => object): Promise<StatusResult> {
  const base = r.inlineResult ? reply(r.inlineResult) : {};
  return created(r.status === 'rejected' ? { ...base, ...(await arrivalOutcome(ctx, r)) } : { arrivalId: r.arrivalId, ...base });
}

export const objectBody = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Send a JSON object.' });
  }
  return raw as Record<string, unknown>;
};
