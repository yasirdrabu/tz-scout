import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { buyingRole, personRole } from '@/modules/accounts/db/schema';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId); // tenant defaults: buying roles
});

const domain = () => `${newId('acc').slice(-10).toLowerCase()}.example.com`;

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: new Date('2026-10-26T15:00:00Z'),
    sourceChain: { personSourceId: 'src_person1', agentSourceId: 'src_agent1' },
    account: {},
    people: [],
    signals: [],
    facts: [],
    research: {},
    soleProprietor: false,
    externalIds: [],
    ...over,
  };
}

const rolesOf = async (personId: string) =>
  (await t.run((ctx) => ctx.tx.select().from(personRole).where(eq(personRole.personId, personId))))
    .map((r) => `${r.roleKey}:${r.origin}`)
    .sort();

async function add(person: ArrivalForAccounts['people'][number], accountId?: string) {
  const out = await t.run((ctx) =>
    upsertFromArrival(ctx, arrival({ account: accountId ? {} : { name: 'Guess Co', domain: domain() }, people: [person] }), accountId),
  );
  return { accountId: out.accountId, personId: [...out.personIds, ...out.existingPersonIds][0]! };
}

describe('roles guessed from a title (Ruling 6)', () => {
  it('a new person with title CTO and no stated role gets technical_buyer as guessed_from_title', async () => {
    const { personId } = await add({ firstName: 'Cy', lastName: 'Tao', title: 'CTO' });
    expect(await rolesOf(personId)).toEqual(['technical_buyer:guessed_from_title']);
  });

  it('a later arrival stating the role upgrades the guess to stated', async () => {
    const a = await add({ firstName: 'Up', lastName: 'Grade', title: 'CTO' });
    await add({ firstName: 'Up', lastName: 'Grade', roleKeys: ['technical_buyer'] }, a.accountId);
    expect(await rolesOf(a.personId)).toEqual(['technical_buyer:stated']);
  });

  it('a person with a stated role gets no guesses', async () => {
    const { personId } = await add({ firstName: 'St', lastName: 'Ated', title: 'CFO', roleKeys: ['business_owner'] });
    expect(await rolesOf(personId)).toEqual(['business_owner:stated']);
  });

  it('Review Focus 1: a guess, then a different stated role, keeps both and the guess stays guessed', async () => {
    const a = await add({ firstName: 'Mix', lastName: 'Ed', title: 'CTO' });
    await add({ firstName: 'Mix', lastName: 'Ed', roleKeys: ['champion'] }, a.accountId);
    expect(await rolesOf(a.personId)).toEqual(['champion:stated', 'technical_buyer:guessed_from_title']);
  });

  it('Review Focus 2: a removed guess is not re-added while the person holds another role', async () => {
    const a = await add({ firstName: 'Re', lastName: 'Moved', title: 'CTO' });
    await t.run((ctx) => ctx.tx.delete(personRole).where(eq(personRole.personId, a.personId)));
    await t.run((ctx) => ctx.tx.insert(personRole).values({ tenantId: ctx.tenantId, personId: a.personId, roleKey: 'champion', origin: 'set_by_person' }));
    await add({ firstName: 'Re', lastName: 'Moved', title: 'CTO' }, a.accountId);
    expect(await rolesOf(a.personId)).toEqual(['champion:set_by_person']);
  });

  it('an existing person with no roles gets guesses on the next arrival', async () => {
    const a = await add({ firstName: 'No', lastName: 'Roles' });
    expect(await rolesOf(a.personId)).toEqual([]);
    await add({ firstName: 'No', lastName: 'Roles', title: 'Director of Purchasing' }, a.accountId);
    expect(await rolesOf(a.personId)).toEqual(['procurement:guessed_from_title']);
  });

  it('guessedRoleKeys join the title guesses', async () => {
    const { personId } = await add({ firstName: 'Gu', lastName: 'Ess', title: 'CTO', guessedRoleKeys: ['champion'] });
    expect(await rolesOf(personId)).toEqual(['champion:guessed_from_title', 'technical_buyer:guessed_from_title']);
  });

  it('a guess for an archived role is dropped', async () => {
    const t2 = await freshTenant();
    await runOutbox(t2.tenantId);
    await adminDb.update(buyingRole).set({ archived: true }).where(and(eq(buyingRole.tenantId, t2.tenantId), eq(buyingRole.key, 'technical_buyer')));
    const out = await t2.run((ctx) =>
      upsertFromArrival(
        ctx,
        arrival({ account: { name: 'Arch Co', domain: domain() }, people: [{ firstName: 'Ar', lastName: 'Chived', title: 'CTO', guessedRoleKeys: ['champion'] }] }),
      ),
    );
    const roles = await t2.run((ctx) => ctx.tx.select().from(personRole).where(eq(personRole.personId, out.personIds[0]!)));
    expect(roles.map((r) => `${r.roleKey}:${r.origin}`)).toEqual(['champion:guessed_from_title']);
  });
});
