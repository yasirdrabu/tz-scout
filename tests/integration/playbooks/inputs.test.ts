import { describe, expect, it } from 'vitest';
import { editPerson } from '@/modules/accounts';
import { buildBriefInput } from '@/modules/playbooks/services/inputs';
import { asPerson, routingTenant, scoredAccount } from './helpers';

describe('buildBriefInput people roles', () => {
  it('leaves roles guessed from a title out, and includes them once confirmed', async () => {
    const t = await routingTenant();
    const id = await scoredAccount(t, 'watch', { people: [{ firstName: 'Ana', lastName: 'Lopez', email: 'ana@example.com', guessedRoleKeys: ['technical_buyer'] }] });
    const people = async () => (await t.run((ctx) => buildBriefInput(ctx, id)))!.input.people;
    const [before] = await people();
    expect([before!.roleKeys, before!.roleLabels]).toEqual([[], []]);
    await asPerson(t, (ctx) => editPerson(ctx, before!.id, { confirmRoleKeys: ['technical_buyer'] }));
    const [after] = await people();
    expect(after!.roleKeys).toEqual(['technical_buyer']);
    expect(after!.roleLabels).toHaveLength(1);
  });
});
