import { beforeAll, describe, expect, it } from 'vitest';
import { crmOperations, type CrmAdapter } from '@/modules/crm';

type Opts = {
  /** Shown in the suite name. */
  name: string;
  /** When true the suite is skipped (the live run, without its token). */
  skip?: boolean;
};

const unique = () => `contract-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const EARLY = '2000-01-01T00:00:00.000Z';

/**
 * The checks every CRM connector must pass (CRM-E1-S1-AC2): each operation's output matches its schema,
 * and the same write twice gives the same external ids and no duplicates.
 */
export function runAdapterContract(make: () => CrmAdapter, opts: Opts): void {
  describe.skipIf(opts.skip)(`CRM adapter contract: ${opts.name}`, () => {
    let adapter: CrmAdapter;
    const slug = unique();
    const domain = `${slug}.example`;
    const email = `pat@${domain}`;
    const check = <K extends keyof typeof crmOperations>(op: K, value: unknown) => crmOperations[op].output.parse(value);
    const state: { company?: string; person?: string; note?: string; task?: string; owner: string | null } = { owner: null };

    beforeAll(() => {
      adapter = make();
    });

    it('tests its connection', async () => {
      expect((await adapter.test()).ok).toBe(true);
    });

    it('lists owners', async () => {
      const owners = check('listOwners', await adapter.listOwners({})) as { externalId: string }[];
      state.owner = owners[0]?.externalId ?? null;
    });

    it('finds nothing for a company it does not have', async () => {
      expect(check('findCompany', await adapter.findCompany({ domain }))).toBeNull();
    });

    it('creates a company once and finds it again', async () => {
      const input = { domain, name: `Contract ${slug}`, ownerExternalId: state.owner, replaceableOwner: false, properties: {} };
      const first = check('upsertCompany', await adapter.upsertCompany(input)) as { externalId: string; created: boolean };
      const second = check('upsertCompany', await adapter.upsertCompany(input)) as { externalId: string; created: boolean };
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.externalId).toBe(first.externalId);
      state.company = first.externalId;
      const found = check('findCompany', await adapter.findCompany({ domain })) as { externalId: string } | null;
      expect(found?.externalId).toBe(first.externalId);
    });

    it('creates a person once, found by email or by name', async () => {
      const input = { name: 'Pat Lee', title: 'CTO', email, ownerExternalId: state.owner, takeOverOwner: false, companyExternalId: state.company! };
      const first = check('upsertPerson', await adapter.upsertPerson(input)) as { externalId: string; created: boolean };
      const second = check('upsertPerson', await adapter.upsertPerson(input)) as { externalId: string; created: boolean };
      expect(second.externalId).toBe(first.externalId);
      expect(second.created).toBe(false);
      state.person = first.externalId;
      const byEmail = check('findPerson', await adapter.findPerson({ email })) as { externalId: string } | null;
      expect(byEmail?.externalId).toBe(first.externalId);
      const byName = check('findPerson', await adapter.findPerson({ name: 'Pat Lee', companyExternalId: state.company! })) as { externalId: string } | null;
      expect(byName?.externalId).toBe(first.externalId);
      expect(check('findPerson', await adapter.findPerson({ email: `nobody@${domain}` }))).toBeNull();
    });

    it('writes a note once and updates it in place', async () => {
      const first = check(
        'upsertNote',
        await adapter.upsertNote({ companyExternalId: state.company!, personExternalIds: [state.person!], html: '<p>Context</p>', ownerExternalId: state.owner }),
      ) as { externalId: string; fingerprint: string; kept: boolean };
      expect(first.kept).toBe(false);
      const again = check(
        'upsertNote',
        await adapter.upsertNote({
          externalId: first.externalId,
          expectedFingerprint: first.fingerprint,
          companyExternalId: state.company!,
          html: '<p>Context</p>',
          ownerExternalId: state.owner,
        }),
      ) as { externalId: string; fingerprint: string; kept: boolean };
      expect(again.externalId).toBe(first.externalId);
      expect(again.fingerprint).toBe(first.fingerprint);
      expect(again.kept).toBe(false);
      state.note = first.externalId;
    });

    it('writes a task once and updates it in place', async () => {
      const input = {
        companyExternalId: state.company!,
        personExternalId: state.person!,
        subject: 'First touch',
        body: 'Call Pat.',
        ownerExternalId: state.owner,
        dueAt: '2030-01-01T00:00:00.000Z',
      };
      const first = check('upsertTask', await adapter.upsertTask(input)) as { externalId: string; status: string };
      const second = check('upsertTask', await adapter.upsertTask({ ...input, externalId: first.externalId })) as { externalId: string; status: string };
      expect(second.externalId).toBe(first.externalId);
      expect(second.status).toBe('open');
      state.task = first.externalId;
    });

    it('reads follow-through for the company and its task', async () => {
      const r = check('readFollowThrough', await adapter.readFollowThrough({ companyExternalId: state.company!, taskExternalIds: [state.task!] })) as {
        tasks: { externalId: string }[];
      };
      expect(r.tasks.map((t) => t.externalId)).toEqual([state.task]);
    });

    it('closes a task, and closing it again changes nothing', async () => {
      expect(check('closeTask', await adapter.closeTask({ externalId: state.task! }))).toEqual({ status: 'completed' });
      expect(check('closeTask', await adapter.closeTask({ externalId: state.task! }))).toEqual({ status: 'completed' });
    });

    it('lists activities, deals and qualified leads', async () => {
      check('listActivities', await adapter.listActivities({ companyExternalId: state.company!, since: EARLY }));
      check('listDeals', await adapter.listDeals({ companyExternalId: state.company! }));
      check('listDeals', await adapter.listDeals({ changedSince: EARLY }));
      const rule = { property: 'lifecyclestage', value: 'marketingqualifiedlead' };
      check('listQualifiedLeads', await adapter.listQualifiedLeads({ changedSince: EARLY, rule }));
      expect(check('readQualifiedLead', await adapter.readQualifiedLead({ contactId: 'no-such-contact', rule }))).toBeNull();
    });

    it('sets up properties once and lists them', async () => {
      const wanted = [{ name: 'taazaa_tier', label: 'Tier', type: 'string' as const }];
      check('existingProperties', await adapter.existingProperties({}));
      check('setUpProperties', await adapter.setUpProperties({ groupName: 'scout_buyer_signals', properties: wanted }));
      const second = check('setUpProperties', await adapter.setUpProperties({ groupName: 'scout_buyer_signals', properties: wanted })) as { created: string[] };
      expect(second.created).toEqual([]);
    });

    it('verifies and parses webhooks', async () => {
      check('verifyWebhook', await adapter.verifyWebhook({ method: 'POST', url: 'https://example.com/hook', headers: {}, rawBody: '[]' }));
      check('parseWebhook', await adapter.parseWebhook({ rawBody: '[]' }));
    });

    it('says what it can do', () => {
      expect(typeof adapter.capabilities.webhooks.deals).toBe('boolean');
    });
  });
}
