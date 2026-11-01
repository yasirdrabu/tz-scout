import { getAccount, getSignals, type PersonView } from '@/modules/accounts';
import { getArrival, sourceNames, type InlineResult, type SubmitResult } from '@/modules/intake';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { notFound } from '../_lib/path';
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

/** An account with its people (contacts only with people:read) and live signals. A missing or hidden one is a 404. */
export async function accountOf(ctx: ModuleContext, id: string, canReadPeople: boolean) {
  const account = await getAccount(ctx, id);
  if (!account) throw notFound();
  return { ...account, mergedInto: account.mergedInto ?? null, people: account.people.map((p) => personFor(p, canReadPeople)), signals: await namedSignals(ctx, account.id) };
}

/** Live signals, each with its sources by name (no arrivals:read needed) and `sourceName`, the nearest of vendor, agent and person. */
async function namedSignals(ctx: ModuleContext, accountId: string) {
  const signals = await getSignals(ctx, accountId);
  const chain = (s: (typeof signals)[number]) => [s.sourceChain.personSourceId, s.sourceChain.agentSourceId, s.sourceChain.vendorSourceId];
  const names = await sourceNames(ctx, [...new Set(signals.flatMap(chain).filter((x): x is string => !!x))]);
  const name = (id: string | null | undefined) => (id ? (names.get(id) ?? null) : null);
  return signals.map((s) => {
    const byKind = { person: name(s.sourceChain.personSourceId), agent: name(s.sourceChain.agentSourceId), vendor: name(s.sourceChain.vendorSourceId) };
    return { ...s, sourceName: byKind.vendor ?? byKind.agent ?? byKind.person, sourceNames: byKind };
  });
}
