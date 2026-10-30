import { and, asc, eq, gte, like, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { RateLimitedError } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { withTenant, type Tx } from '@/platform/db/tenant';
import { webhookEventSchema, type CrmAdapter, type CrmDeal } from '../../contracts/adapter';
import { mockActivity, mockCompany, mockDeal, mockFailure, mockNote, mockOwner, mockPerson, mockProperty, mockTask } from '../../db/schema';
import { noteFingerprint } from '../../domain/fingerprint';

// The Postgres-backed HubSpot stand-in (Ruling 2). Every write is its own transaction, like a CRM that does
// not roll back when the caller does, and the rules are those of the v1 live connector.

export type MockFailureKind = '401' | '403' | '429' | '500' | 'timeout';

/** Standard HubSpot company properties, which always exist. Scout's own (`taazaa_*`, `scout_link`) exist only after "Set up HubSpot fields". */
const KNOWN_PROPERTIES = new Set([
  'name',
  'domain',
  'website',
  'description',
  'hubspot_owner_id',
  'lifecyclestage',
  'numberofemployees',
]);

export const ID_PREFIX = {
  company: 'mock-co-',
  person: 'mock-ct-',
  note: 'mock-nt-',
  task: 'mock-tk-',
  deal: 'mock-dl-',
  owner: 'mock-ow-',
  activity: 'mock-ac-',
} as const;

type IdTable = { externalId: PgColumn; tenantId: PgColumn };

/** The next `<prefix><n>` for the tenant. The tenant's id lock keeps two writers from picking the same number. */
export async function nextMockId(tx: Tx, tenantId: string, table: IdTable, prefix: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'crm-mock:' + tenantId}))`);
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(substring(${table.externalId} from ${prefix.length + 1}::int)::int), 0) + 1` })
    .from(table as unknown as typeof mockOwner)
    .where(and(eq(table.tenantId, tenantId), like(table.externalId, `${prefix}%`)));
  return `${prefix}${row!.n}`;
}

const clean = (o: Record<string, string | number | null | undefined>): Record<string, string | number> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '')) as Record<string, string | number>;

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Fails the operation when a test asked it to (`setMockFailure`), counting down in its own transaction. */
async function consumeFailure(ctx: ModuleContext, operation: string): Promise<void> {
  const kind = await withTenant(ctx.tenantId, async (tx) => {
    const where = and(eq(mockFailure.tenantId, ctx.tenantId), eq(mockFailure.operation, operation));
    const [row] = await tx.select().from(mockFailure).where(where).for('update');
    if (!row || row.remaining <= 0) return null;
    await tx.update(mockFailure).set({ remaining: row.remaining - 1 }).where(where);
    return row.kind as MockFailureKind;
  });
  if (kind === '401') throw httpError(401, 'HubSpot refused the token (sample data).');
  if (kind === '403') throw httpError(403, 'HubSpot needs another permission: crm.objects.companies.write.');
  if (kind === '429') throw new RateLimitedError('HubSpot asked us to slow down (sample data).');
  if (kind === '500') throw httpError(500, 'HubSpot returned 500 (sample data).');
  if (kind === 'timeout') throw Object.assign(new Error('HubSpot timed out (sample data).'), { name: 'TimeoutError' });
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const dealOut = (d: typeof mockDeal.$inferSelect): CrmDeal => ({
  externalId: d.externalId,
  companyExternalId: d.companyExternalId,
  name: d.name,
  stage: d.stage,
  status: d.status as CrmDeal['status'],
  amountCents: d.amountCents,
  currency: d.currency,
  openedAt: iso(d.openedAt),
  closedAt: iso(d.closedAt),
});

export function hubspotMock(ctx: ModuleContext): CrmAdapter {
  const tenantId = ctx.tenantId;
  /** One operation: the failure check, then the work in its own transaction. */
  const run = async <T>(operation: string, fn: (tx: Tx) => Promise<T>): Promise<T> => {
    await consumeFailure(ctx, operation);
    return withTenant(tenantId, fn);
  };

  const companyById = async (tx: Tx, id: string) =>
    (await tx.select().from(mockCompany).where(and(eq(mockCompany.tenantId, tenantId), eq(mockCompany.externalId, id))))[0];
  const personById = async (tx: Tx, id: string) =>
    (await tx.select().from(mockPerson).where(and(eq(mockPerson.tenantId, tenantId), eq(mockPerson.externalId, id))))[0];
  const taskById = async (tx: Tx, id: string) =>
    (await tx.select().from(mockTask).where(and(eq(mockTask.tenantId, tenantId), eq(mockTask.externalId, id))))[0];
  const companyWhere = (id: string) => and(eq(mockCompany.tenantId, tenantId), eq(mockCompany.externalId, id));
  const personWhere = (id: string) => and(eq(mockPerson.tenantId, tenantId), eq(mockPerson.externalId, id));
  const noteWhere = (id: string) => and(eq(mockNote.tenantId, tenantId), eq(mockNote.externalId, id));
  const taskWhere = (id: string) => and(eq(mockTask.tenantId, tenantId), eq(mockTask.externalId, id));
  const dealsOf = (tx: Tx, companyExternalId: string) =>
    tx
      .select()
      .from(mockDeal)
      .where(and(eq(mockDeal.tenantId, tenantId), eq(mockDeal.companyExternalId, companyExternalId)))
      .orderBy(asc(mockDeal.externalId));

  async function findPersonRow(tx: Tx, input: { email: string } | { name: string; companyExternalId: string }) {
    const where =
      'email' in input
        ? and(eq(mockPerson.tenantId, tenantId), sql`lower(${mockPerson.email}) = ${input.email.trim().toLowerCase()}`)
        : and(
            eq(mockPerson.tenantId, tenantId),
            eq(mockPerson.companyExternalId, input.companyExternalId),
            sql`lower(${mockPerson.name}) = ${input.name.trim().toLowerCase()}`,
          );
    return (await tx.select().from(mockPerson).where(where).orderBy(asc(mockPerson.createdAt)).limit(1))[0];
  }

  async function leadOut(tx: Tx, p: typeof mockPerson.$inferSelect) {
    const c = p.companyExternalId ? await companyById(tx, p.companyExternalId) : undefined;
    return {
      contact: { externalId: p.externalId, name: p.name, email: p.email, title: p.title, phone: p.phones[0] ?? null, linkedin: p.linkedin },
      company: c
        ? { externalId: c.externalId, name: c.name, domain: c.domain, website: c.website, location: c.location, employees: c.employees, description: c.description }
        : null,
      lifecycleStage: p.lifecycle ?? '',
      qualifiedAt: (p.qualifiedAt ?? p.createdAt).toISOString(),
      raw: { id: p.externalId, lifecyclestage: p.lifecycle },
    };
  }

  return {
    capabilities: { webhooks: { deals: true, activities: true, lifecycle: true }, customProperties: true, taskDueDates: true, noteFingerprint: true, ownerRoster: true },

    async test() {
      return { ok: true, message: 'This environment uses sample data only.' };
    },

    findCompany: ({ domain }) =>
      run('findCompany', async (tx) => {
        const [c] = await tx
          .select()
          .from(mockCompany)
          .where(and(eq(mockCompany.tenantId, tenantId), eq(mockCompany.domain, domain.trim().toLowerCase())));
        if (!c) return null;
        const deals = await dealsOf(tx, c.externalId);
        return {
          externalId: c.externalId,
          name: c.name,
          ownerExternalId: c.ownerExternalId,
          lifecycle: c.lifecycle,
          openDeals: deals.filter((d) => d.status === 'open').length,
          deals: deals.map(dealOut),
        };
      }),

    upsertCompany: (input) =>
      run('upsertCompany', async (tx) => {
        const domain = input.domain.trim().toLowerCase();
        const existing = input.externalId
          ? await companyById(tx, input.externalId)
          : (await tx.select().from(mockCompany).where(and(eq(mockCompany.tenantId, tenantId), eq(mockCompany.domain, domain))))[0];
        const props = clean(input.properties);
        if (existing) {
          // Fill gaps and refresh Scout's fields; never take a company from the owner it already has.
          const mayOwn = !existing.ownerExternalId || input.replaceableOwner || existing.ownerExternalId === input.ownerExternalId;
          const owner = mayOwn && input.ownerExternalId ? input.ownerExternalId : existing.ownerExternalId;
          await tx
            .update(mockCompany)
            .set({
              website: existing.website ?? input.website ?? null,
              location: existing.location ?? input.location ?? null,
              employees: existing.employees ?? input.employees ?? null,
              description: existing.description ?? input.description ?? null,
              ownerExternalId: owner,
              properties: { ...existing.properties, ...props },
            })
            .where(companyWhere(existing.externalId));
          return { externalId: existing.externalId, created: false, ownerExternalId: owner };
        }
        const externalId = await nextMockId(tx, tenantId, mockCompany, ID_PREFIX.company);
        await tx.insert(mockCompany).values({
          tenantId,
          externalId,
          domain,
          name: input.name,
          website: input.website ?? null,
          location: input.location ?? null,
          employees: input.employees ?? null,
          description: input.description ?? null,
          ownerExternalId: input.ownerExternalId,
          properties: props,
        });
        return { externalId, created: true, ownerExternalId: input.ownerExternalId };
      }),

    findPerson: (input) =>
      run('findPerson', async (tx) => {
        const p = await findPersonRow(tx, input);
        return p ? { externalId: p.externalId, ownerExternalId: p.ownerExternalId } : null;
      }),

    upsertPerson: (input) =>
      run('upsertPerson', async (tx) => {
        const existing = input.externalId
          ? await personById(tx, input.externalId)
          : input.email
            ? await findPersonRow(tx, { email: input.email })
            : await findPersonRow(tx, { name: input.name, companyExternalId: input.companyExternalId });
        if (existing) {
          // Same rule as companies: keep an owner that is already set unless the handoff says to take it over.
          const take = !!input.ownerExternalId && (input.takeOverOwner || (!existing.ownerExternalId && !input.externalId));
          await tx
            .update(mockPerson)
            .set({
              name: input.name,
              title: input.title ?? existing.title,
              email: input.email ?? existing.email,
              phones: input.phones?.length ? input.phones : existing.phones,
              linkedin: input.linkedin ?? existing.linkedin,
              companyExternalId: input.companyExternalId,
              ownerExternalId: take ? input.ownerExternalId : existing.ownerExternalId,
            })
            .where(personWhere(existing.externalId));
          return { externalId: existing.externalId, created: false };
        }
        const externalId = await nextMockId(tx, tenantId, mockPerson, ID_PREFIX.person);
        await tx.insert(mockPerson).values({
          tenantId,
          externalId,
          name: input.name,
          title: input.title ?? null,
          email: input.email ?? null,
          phones: input.phones ?? [],
          linkedin: input.linkedin ?? null,
          companyExternalId: input.companyExternalId,
          ownerExternalId: input.ownerExternalId,
        });
        return { externalId, created: true };
      }),

    upsertNote: (input) =>
      run('upsertNote', async (tx) => {
        const fingerprint = noteFingerprint(input.html);
        if (input.externalId) {
          const [current] = await tx.select().from(mockNote).where(noteWhere(input.externalId));
          // Update in place only when the note is still exactly what Scout last wrote (or Scout has no record of it).
          const untouched = !!current && (!input.expectedFingerprint || noteFingerprint(current.html) === input.expectedFingerprint);
          if (untouched) {
            await tx.update(mockNote).set({ html: input.html, fingerprint }).where(noteWhere(input.externalId));
            return { externalId: input.externalId, fingerprint, kept: false };
          }
        }
        const externalId = await nextMockId(tx, tenantId, mockNote, ID_PREFIX.note);
        await tx.insert(mockNote).values({
          tenantId,
          externalId,
          companyExternalId: input.companyExternalId,
          personExternalId: input.personExternalIds?.[0] ?? null,
          html: input.html,
          fingerprint,
          ownerExternalId: input.ownerExternalId,
        });
        // kept: an earlier note existed but had been edited in the CRM, so it was left as is.
        return { externalId, fingerprint, kept: !!input.externalId };
      }),

    upsertTask: (input) =>
      run('upsertTask', async (tx) => {
        const values = {
          companyExternalId: input.companyExternalId,
          personExternalId: input.personExternalId ?? null,
          subject: input.subject,
          body: input.body,
          ownerExternalId: input.ownerExternalId,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
        };
        if (input.externalId) {
          const current = await taskById(tx, input.externalId);
          if (current) {
            // A completed task is left as it is: not reopened, and no second one is made.
            if (current.status === 'completed') return { externalId: current.externalId, status: 'completed' as const };
            await tx.update(mockTask).set(values).where(taskWhere(input.externalId));
            return { externalId: input.externalId, status: 'open' as const };
          }
        }
        const externalId = await nextMockId(tx, tenantId, mockTask, ID_PREFIX.task);
        await tx.insert(mockTask).values({ tenantId, externalId, ...values });
        return { externalId, status: 'open' as const };
      }),

    closeTask: ({ externalId }) =>
      run('closeTask', async (tx) => {
        if (!(await taskById(tx, externalId))) throw httpError(404, `HubSpot task ${externalId} was not found (sample data).`);
        await tx.update(mockTask).set({ status: 'completed' }).where(taskWhere(externalId));
        return { status: 'completed' as const };
      }),

    listOwners: () =>
      run('listOwners', async (tx) => {
        const rows = await tx.select().from(mockOwner).where(eq(mockOwner.tenantId, tenantId)).orderBy(asc(mockOwner.externalId));
        return rows.map((o) => ({ externalId: o.externalId, name: o.name, email: o.email, active: o.active }));
      }),

    readFollowThrough: ({ companyExternalId, taskExternalIds }) =>
      run('readFollowThrough', async (tx) => {
        const company = await companyById(tx, companyExternalId);
        const taskRows = taskExternalIds.length ? await tx.select().from(mockTask).where(eq(mockTask.tenantId, tenantId)) : [];
        const tasks = taskRows
          .filter((t) => taskExternalIds.includes(t.externalId))
          .map((t) => ({ externalId: t.externalId, status: t.status as 'open' | 'completed', dueAt: iso(t.dueAt) }));
        const acts = await tx
          .select()
          .from(mockActivity)
          .where(and(eq(mockActivity.tenantId, tenantId), eq(mockActivity.companyExternalId, companyExternalId)));
        const deals = await dealsOf(tx, companyExternalId);
        const count = (...kinds: string[]) => acts.filter((a) => kinds.includes(a.kind)).length;
        const last = acts.reduce<Date | null>((m, a) => (!m || a.occurredAt > m ? a.occurredAt : m), null);
        return {
          tasks,
          emails: count('email', 'reply'),
          calls: count('call'),
          meetings: count('meeting'),
          deals: deals.length,
          openDeals: deals.filter((d) => d.status === 'open').length,
          stage: company?.lifecycle ?? null,
          ownerExternalId: company?.ownerExternalId ?? null,
          lastActivityAt: iso(last),
        };
      }),

    listActivities: ({ companyExternalId, since }) =>
      run('listActivities', async (tx) => {
        const rows = await tx
          .select()
          .from(mockActivity)
          .where(and(eq(mockActivity.tenantId, tenantId), eq(mockActivity.companyExternalId, companyExternalId), gte(mockActivity.occurredAt, new Date(since))))
          .orderBy(asc(mockActivity.occurredAt), asc(mockActivity.externalId));
        return rows.map((a) => ({
          externalId: a.externalId,
          kind: a.kind as 'email' | 'reply' | 'call' | 'meeting' | 'task_done',
          occurredAt: a.occurredAt.toISOString(),
          actorOwnerExternalId: a.actorOwnerExternalId,
        }));
      }),

    listDeals: (input) =>
      run('listDeals', async (tx) => {
        if ('companyExternalId' in input) return (await dealsOf(tx, input.companyExternalId)).map(dealOut);
        const rows = await tx
          .select()
          .from(mockDeal)
          .where(and(eq(mockDeal.tenantId, tenantId), gte(mockDeal.updatedAt, new Date(input.changedSince))))
          .orderBy(asc(mockDeal.externalId));
        return rows.map(dealOut);
      }),

    // The mock keeps one lifecycle per contact, so only the lifecycle property can be a rule.
    listQualifiedLeads: ({ changedSince, rule }) =>
      run('listQualifiedLeads', async (tx) => {
        if (rule.property !== 'lifecyclestage') return [];
        const rows = await tx
          .select()
          .from(mockPerson)
          .where(and(eq(mockPerson.tenantId, tenantId), eq(mockPerson.lifecycle, rule.value), gte(mockPerson.qualifiedAt, new Date(changedSince))))
          .orderBy(asc(mockPerson.qualifiedAt), asc(mockPerson.externalId));
        return Promise.all(rows.map((p) => leadOut(tx, p)));
      }),

    readQualifiedLead: ({ contactId, rule }) =>
      run('readQualifiedLead', async (tx) => {
        const p = await personById(tx, contactId);
        return p && rule.property === 'lifecyclestage' && p.lifecycle === rule.value ? leadOut(tx, p) : null;
      }),


    existingProperties: () =>
      run('existingProperties', async (tx) => {
        const rows = await tx.select({ name: mockProperty.name }).from(mockProperty).where(eq(mockProperty.tenantId, tenantId)).orderBy(asc(mockProperty.name));
        return [...KNOWN_PROPERTIES, ...rows.map((r) => r.name)];
      }),

    setUpProperties: ({ groupName, properties }) =>
      run('setUpProperties', async (tx) => {
        const created: string[] = [];
        for (const p of properties) {
          if (KNOWN_PROPERTIES.has(p.name)) continue;
          const rows = await tx
            .insert(mockProperty)
            .values({ tenantId, name: p.name, label: p.label, groupName })
            .onConflictDoNothing()
            .returning({ name: mockProperty.name });
          if (rows.length) created.push(p.name);
        }
        return { created };
      }),

    // Sample webhooks carry `x-hubspot-signature-v3: mock-valid`; the real check is the pure verifyHubSpotV3.
    verifyWebhook: ({ headers }) => run('verifyWebhook', async () => headers['x-hubspot-signature-v3'] === 'mock-valid'),

    parseWebhook: ({ rawBody }) =>
      run('parseWebhook', async () => {
        try {
          const parsed = webhookEventSchema.array().safeParse(JSON.parse(rawBody));
          return parsed.success ? parsed.data : [];
        } catch {
          return [];
        }
      }),
  };
}
