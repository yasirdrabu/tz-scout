import { describe, expect, it } from 'vitest';
import { buildPlan, localDate, type PlanInput, type TemplateStepInput } from '@/modules/playbooks/domain/plan';

const step = (over: Partial<TemplateStepInput>): TemplateStepInput => ({
  id: 'pls_1',
  order: 1,
  day: 0,
  channel: 'task',
  ownerRole: 'seller',
  title: 'Do it',
  detail: null,
  targetBuyingRoles: [],
  crmTask: true,
  subject: null,
  body: null,
  ...over,
});

const input = (steps: TemplateStepInput[], over: Partial<PlanInput> = {}): PlanInput => ({
  template: { id: 'plb_1', version: 3, stopWhen: 'meeting' },
  steps,
  startAt: new Date('2026-11-06T15:00:00Z'), // Friday
  timezone: 'America/New_York',
  sellerUserId: 'usr_seller',
  leaderUserId: 'usr_leader',
  people: [],
  account: { name: 'Acme' },
  offer: { id: 'off_1', name: 'Opportunity Map', promise: 'a clear AI plan' },
  tier: 'act_now',
  seller: { firstName: 'Sam' },
  ...over,
});

describe('buildPlan due dates', () => {
  it('moves a Friday start plus one day to Monday', () => {
    const plan = buildPlan(input([step({ day: 1 })]));
    expect(plan.startDate).toBe('2026-11-06');
    expect(plan.steps[0]!.dueDate).toBe('2026-11-09');
  });

  it('moves day 0 on a Saturday to the following Monday, and keeps a weekday', () => {
    const sat = buildPlan(input([step({ day: 0 })], { startAt: new Date('2026-11-07T15:00:00Z') }));
    expect(sat.steps[0]!.dueDate).toBe('2026-11-09');
    const fri = buildPlan(input([step({ day: 0 }), step({ day: 7, order: 2 }), step({ day: 8, order: 3 })]));
    expect(fri.steps.map((s) => s.dueDate)).toEqual(['2026-11-06', '2026-11-13', '2026-11-16']);
  });

  it('takes the start day in the tenant timezone, not UTC', () => {
    // 02:00 UTC Saturday is still Friday evening in New York.
    const plan = buildPlan(input([step({ day: 1 })], { startAt: new Date('2026-11-07T02:00:00Z') }));
    expect(plan.startDate).toBe('2026-11-06');
    expect(plan.steps[0]!.dueDate).toBe('2026-11-09');
    expect(localDate(new Date('2026-11-07T02:00:00Z').getTime(), 'Asia/Karachi')).toBe('2026-11-07');
  });
});

describe('buildPlan owners and snapshot', () => {
  it('follows the roles', () => {
    const plan = buildPlan(input([step({ ownerRole: 'seller' }), step({ ownerRole: 'leader', order: 2 }), step({ ownerRole: 'operator', order: 3 })]));
    expect(plan.steps.map((s) => s.ownerUserId)).toEqual(['usr_seller', 'usr_leader', null]);
  });

  it('keeps the template snapshot and marks steps as template', () => {
    const plan = buildPlan(input([step({ id: 'pls_9', crmTask: false })]));
    expect(plan).toMatchObject({ templateId: 'plb_1', templateVersion: 3, stopWhen: 'meeting', offerId: 'off_1', tier: 'act_now' });
    expect(plan.steps[0]).toMatchObject({ templateStepId: 'pls_9', origin: 'template', crmTask: false, status: 'todo' });
  });

  it('orders steps by order', () => {
    const plan = buildPlan(input([step({ order: 2, title: 'B' }), step({ order: 1, title: 'A' })]));
    expect(plan.steps.map((s) => s.title)).toEqual(['A', 'B']);
  });
});

describe('buildPlan people and text', () => {
  const people = [
    { id: 'per_guess', firstName: 'Gus', roles: [{ key: 'business_owner', origin: 'guessed_from_title' as const }] },
    { id: 'per_set', firstName: 'Priya', roles: [{ key: 'business_owner', origin: 'set_by_person' as const }] },
    { id: 'per_stated', firstName: 'Stan', roles: [{ key: 'commercial_buyer', origin: 'stated' as const }] },
  ];

  it('links only stated or set people, never a guess', () => {
    const plan = buildPlan(input([step({ targetBuyingRoles: ['business_owner'] }), step({ order: 2, targetBuyingRoles: ['business_owner', 'commercial_buyer'] }), step({ order: 3 })], { people }));
    expect(plan.steps[0]!.targetPersonIds).toEqual(['per_set']);
    expect(plan.steps[1]!.targetPersonIds).toEqual(['per_set', 'per_stated']);
    expect(plan.steps[2]!.targetPersonIds).toEqual([]);
  });

  it('renders placeholders with the first linked person', () => {
    const plan = buildPlan(
      input(
        [step({ channel: 'email', targetBuyingRoles: ['business_owner'], subject: '{offer.name} for {account.name}', body: 'Hi {person.first_name}, {seller.first_name} here. {offer.promise}', detail: 'Write to {person.first_name}' })],
        { people },
      ),
    );
    expect(plan.steps[0]).toMatchObject({ subject: 'Opportunity Map for Acme', body: 'Hi Priya, Sam here. a clear AI plan', detail: 'Write to Priya' });
  });

  it('uses the fallbacks when no one is linked', () => {
    const plan = buildPlan(input([step({ channel: 'email', targetBuyingRoles: ['business_owner'], body: 'Hi {person.first_name}', detail: 'Call {person.first_name}' })], { people: [people[0]!] }));
    expect(plan.steps[0]).toMatchObject({ body: 'Hi there', detail: 'Call the contact' });
  });
});
