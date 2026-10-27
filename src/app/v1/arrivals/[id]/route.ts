import { z } from 'zod';
import { chooseDuplicate, getArrival, supplyCompany, supplyWebsite } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { parseBody } from '../../_lib/body';
import { withoutContacts } from '../../_lib/intake';
import { idAndAction, notFound } from '../../_lib/path';
import { byAction, v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'arrivals');
  if (action) throw notFound();
  const found = await getArrival(ctx, id);
  if (!found) throw notFound();
  return can(principal, 'people:read') ? found : withoutContacts(found);
});

const websiteBody = z.strictObject({ website: z.string() });
const companyBody = z.union([
  z.strictObject({ name: z.string(), website: z.string().optional() }),
  z.strictObject({ sole_proprietor: z.literal(true), person_name: z.string().optional() }),
]);
const chooseBody = z.union([z.strictObject({ same_as: z.string() }), z.strictObject({ new_company: z.literal(true) })]);

/** The arrival as it stands after an answer. The resolve job runs next, so it is usually still resolving. */
async function arrivalAfter(ctx: ModuleContext, id: string, canReadPeople: boolean) {
  const found = await getArrival(ctx, id);
  if (!found) throw notFound();
  return canReadPeople ? found : withoutContacts(found);
}

/** `POST /arrivals/{id}:action`: the answers to what a waiting arrival needs. The operator's story, so `imports:run`. */
export const POST = byAction('arrivals', {
  'supply-website': v1Route({ permission: 'imports:run', peopleOnly: true }, async (req, principal, ctx) => {
    const { id } = idAndAction(req, 'arrivals');
    await supplyWebsite(ctx, id, (await parseBody<{ website: string }>(req, websiteBody)).website);
    return arrivalAfter(ctx, id, can(principal, 'people:read'));
  }),
  'supply-company': v1Route({ permission: 'imports:run', peopleOnly: true }, async (req, principal, ctx) => {
    const { id } = idAndAction(req, 'arrivals');
    const body = await parseBody<{ name?: string; website?: string; soleProprietor?: true; personName?: string }>(req, companyBody);
    await supplyCompany(
      ctx,
      id,
      body.soleProprietor
        ? { soleProprietor: true, personName: body.personName }
        : { name: body.name!, ...(body.website ? { website: body.website } : {}) },
    );
    return arrivalAfter(ctx, id, can(principal, 'people:read'));
  }),
  choose: v1Route({ permission: 'imports:run', peopleOnly: true }, async (req, principal, ctx) => {
    const { id } = idAndAction(req, 'arrivals');
    const body = await parseBody<{ sameAs?: string; newCompany?: true }>(req, chooseBody);
    await chooseDuplicate(ctx, id, body.sameAs ? { kind: 'same_as', accountId: body.sameAs } : { kind: 'new_company' });
    return arrivalAfter(ctx, id, can(principal, 'people:read'));
  }),
});
