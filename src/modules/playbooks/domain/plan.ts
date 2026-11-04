// Building a plan from a template (Rulings 8 and 9). Pure: the caller reads the rows and writes the draft.
import { wallClock } from '@/platform/time';
import { render, type PlaceholderVars } from './placeholders';

export type StepChannel = 'email' | 'linkedin' | 'call' | 'meeting' | 'task';
export type OwnerRole = 'seller' | 'leader' | 'operator';
export type StopWhen = 'reply_or_meeting' | 'meeting' | 'never';
export type Tier = 'act_now' | 'good_fit' | 'watch';

/** A `template_step` row at the version being started. */
export type TemplateStepInput = {
  id: string;
  order: number;
  day: number;
  channel: StepChannel;
  ownerRole: OwnerRole;
  title: string;
  detail: string | null;
  targetBuyingRoles: string[];
  crmTask: boolean;
  subject: string | null;
  body: string | null;
};

/** An account person with the buying roles they hold, from accounts' person and person_role rows. */
export type PlanPerson = {
  id: string;
  firstName: string | null;
  roles: { key: string; origin: 'stated' | 'guessed_from_title' | 'set_by_person' }[];
};

export type PlanInput = {
  template: { id: string; version: number; stopWhen: StopWhen };
  /** The steps of `template.version`, in any order. */
  steps: TemplateStepInput[];
  /** The accept time; the start date is its day in `timezone`. */
  startAt: Date;
  timezone: string;
  sellerUserId: string;
  leaderUserId: string | null;
  people: PlanPerson[];
  account: { name: string };
  /** Null when the account has no lead offer; offer placeholders then stay as written. */
  offer: { id: string; name: string; promise: string | null } | null;
  tier: Tier | null;
  seller: { firstName: string | null };
};

/** A `plan_step` row to insert, minus the ids, the plan id and the tenant. */
export type PlanStepDraft = {
  templateStepId: string;
  order: number;
  day: number;
  channel: StepChannel;
  ownerRole: OwnerRole;
  ownerUserId: string | null;
  title: string;
  detail: string | null;
  targetPersonIds: string[];
  dueDate: string;
  status: 'todo';
  origin: 'template';
  crmTask: boolean;
  subject: string | null;
  body: string | null;
};

/** An `account_plan` row to insert, minus the ids, the tenant, the account and the assignment, with its steps. */
export type PlanDraft = {
  templateId: string;
  templateVersion: number;
  offerId: string | null;
  tier: Tier | null;
  stopWhen: StopWhen;
  /** 'YYYY-MM-DD' */
  startDate: string;
  steps: PlanStepDraft[];
};

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** The calendar date at instant `t` (ms) in the zone, as 'YYYY-MM-DD'. */
export function localDate(t: number, timezone: string): string {
  const w = wallClock(t, timezone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** `start` plus `days` calendar days, moved forward to Monday when it lands on a weekend. Dates are 'YYYY-MM-DD'. */
export function dueDateFor(start: string, days: number): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const due = new Date(Date.UTC(y, m - 1, d + days));
  const dow = due.getUTCDay();
  if (dow === 6) due.setUTCDate(due.getUTCDate() + 2);
  else if (dow === 0) due.setUTCDate(due.getUTCDate() + 1);
  return iso(due);
}

/** Roles a person holds on purpose: stated, or set by someone. Guessed roles do not count. */
const KNOWN_ORIGINS = new Set(['stated', 'set_by_person']);

function linkedPeople(people: PlanPerson[], targetRoles: string[]): PlanPerson[] {
  if (targetRoles.length === 0) return [];
  return people.filter((p) => p.roles.some((r) => KNOWN_ORIGINS.has(r.origin) && targetRoles.includes(r.key)));
}

/** Builds the plan to store: due dates, owners, linked people and rendered text for each template step. */
export function buildPlan(input: PlanInput): PlanDraft {
  const startDate = localDate(input.startAt.getTime(), input.timezone);
  const steps = [...input.steps]
    .sort((a, b) => a.order - b.order)
    .map((s): PlanStepDraft => {
      const linked = linkedPeople(input.people, s.targetBuyingRoles);
      const vars: PlaceholderVars = {
        'account.name': input.account.name,
        'offer.name': input.offer?.name ?? null,
        'offer.promise': input.offer?.promise ?? null,
        'seller.first_name': input.seller.firstName,
        'person.first_name': linked[0]?.firstName ?? null,
      };
      return {
        templateStepId: s.id,
        order: s.order,
        day: s.day,
        channel: s.channel,
        ownerRole: s.ownerRole,
        ownerUserId: s.ownerRole === 'seller' ? input.sellerUserId : s.ownerRole === 'leader' ? input.leaderUserId : null,
        title: s.title,
        detail: s.detail === null ? null : render(s.detail, vars, 'detail'),
        targetPersonIds: linked.map((p) => p.id),
        dueDate: dueDateFor(startDate, s.day),
        status: 'todo',
        origin: 'template',
        crmTask: s.crmTask,
        subject: s.subject === null ? null : render(s.subject, vars, 'email'),
        body: s.body === null ? null : render(s.body, vars, 'email'),
      };
    });
  return {
    templateId: input.template.id,
    templateVersion: input.template.version,
    offerId: input.offer?.id ?? null,
    tier: input.tier,
    stopWhen: input.template.stopWhen,
    startDate,
    steps,
  };
}
