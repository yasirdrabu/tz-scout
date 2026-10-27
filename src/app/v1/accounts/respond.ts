import type { PersonView } from '@/modules/accounts';
import type { InlineResult, SubmitResult } from '@/modules/intake';
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

/** 422 for an arrival the service rejected (the account is excluded; what was sent is kept, as the service reports). */
export const rejectedReply = (r: Pick<SubmitResult, 'arrivalId' | 'status'>): StatusResult => ({
  status: 422,
  body: { arrivalId: r.arrivalId, status: r.status, reason: 'excluded' },
});

/** The reply to an inline targeted arrival: 201 with `reply(result)`, or 422 when it was rejected. */
export function inlineReply(r: SubmitResult, reply: (x: InlineResult) => object): StatusResult {
  return r.status === 'rejected' || !r.inlineResult ? rejectedReply(r) : created(reply(r.inlineResult));
}

export const objectBody = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Send a JSON object.' });
  }
  return raw as Record<string, unknown>;
};
