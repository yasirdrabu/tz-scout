import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  accountPlan,
  brief,
  briefSection,
  briefSectionHistory,
  offerPlaybook,
  planChange,
  planStep,
  playbookTemplate,
  templateStep,
} from '@/modules/playbooks/db/schema';
import { briefUpdated } from '@/modules/playbooks/contracts/events';
import { briefDraftJob } from '@/modules/playbooks/contracts/jobs';
import { BRIEF_KEYS, PAGE_SECTIONS, SECTION_MAX } from '@/modules/playbooks/contracts/types';
import { newId } from '@/platform/ids';
import { freshTenant } from '../integrations/helpers';

describe('playbooks schema', () => {
  it('forces row level security on every playbooks table', async () => {
    const t = await freshTenant(); // the playbooks tables live in the workspace database, not the control plane
    const rows = await t.run((ctx) => ctx.tx.execute<{ name: string; rls: boolean; forced: boolean }>(sql`
      select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'playbooks' and c.relkind in ('r', 'p') and c.relname <> '__migrations' order by 1`));
    expect(rows.map((r) => r.name)).toEqual([
      'account_plan',
      'brief',
      'brief_section',
      'brief_section_history',
      'offer_playbook',
      'plan_change',
      'plan_step',
      'playbook_template',
      'template_step',
    ]);
    expect(rows.every((r) => r.rls && r.forced)).toBe(true);
  });

  it('a row written as tenant A is not read as tenant B', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const accountId = newId('acc');
    await a.run(async (ctx) => {
      await ctx.tx.insert(brief).values({ tenantId: ctx.tenantId, accountId });
      await ctx.tx.insert(briefSection).values({ tenantId: ctx.tenantId, accountId, key: 'overview', body: 'Hi', origin: 'rules', mode: 'rules' });
      await ctx.tx.insert(briefSectionHistory).values({ tenantId: ctx.tenantId, accountId, key: 'overview', version: 1, body: 'Old', origin: 'rules', mode: 'rules' });
    });
    expect(await a.run((ctx) => ctx.tx.select().from(brief))).toHaveLength(1);
    expect(await b.run((ctx) => ctx.tx.select().from(brief))).toHaveLength(0);
    expect(await b.run((ctx) => ctx.tx.select().from(briefSection))).toHaveLength(0);
    expect(await b.run((ctx) => ctx.tx.select().from(briefSectionHistory))).toHaveLength(0);
    const [row] = await a.run((ctx) => ctx.tx.select().from(brief));
    expect(row).toMatchObject({ draftState: 'not_drafted', requestedSeq: 0, draftedSeq: 0, frozenAt: null });
  });
});

describe('playbooks plan tables', () => {
  it('a plan written as tenant A is not read as tenant B, and one open plan per account holds', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const templateId = newId('plb');
    const planId = newId('pln');
    const accountId = newId('acc');
    const plan = (ctx: { tenantId: string }, id: string, assignmentId: string, status = 'active') => ({
      id, tenantId: ctx.tenantId, accountId, offerId: newId('off'), tier: 'act_now', templateId, templateVersion: 1,
      assignmentId, status, stopWhen: 'reply_or_meeting', startDate: '2026-11-06',
    });
    await a.run(async (ctx) => {
      await ctx.tx.insert(playbookTemplate).values({ id: templateId, tenantId: ctx.tenantId, name: 'Standard' });
      await ctx.tx.insert(templateStep).values({ id: newId('pls'), tenantId: ctx.tenantId, templateId, templateVersion: 1, order: 1, day: 0, channel: 'email', ownerRole: 'seller', title: 'Intro' });
      await ctx.tx.insert(offerPlaybook).values({ tenantId: ctx.tenantId, offerId: newId('off'), tier: 'act_now', templateId });
      await ctx.tx.insert(accountPlan).values(plan(ctx, planId, newId('asg')));
      await ctx.tx.insert(planStep).values({ id: newId('stp'), tenantId: ctx.tenantId, planId, order: 1, day: 0, channel: 'email', ownerRole: 'seller', title: 'Intro', dueDate: '2026-11-06' });
      await ctx.tx.insert(planChange).values({ id: newId('pch'), tenantId: ctx.tenantId, planId, kind: 'status', detail: { to: 'active' } });
    });
    for (const table of [playbookTemplate, templateStep, offerPlaybook, accountPlan, planStep, planChange]) {
      expect(await a.run((ctx) => ctx.tx.select().from(table))).toHaveLength(1);
      expect(await b.run((ctx) => ctx.tx.select().from(table))).toHaveLength(0);
    }
    const [row] = await a.run((ctx) => ctx.tx.select().from(planStep));
    expect(row).toMatchObject({ status: 'todo', origin: 'template', crmTask: true, targetPersonIds: [] });

    const second = a.run((ctx) => ctx.tx.insert(accountPlan).values(plan(ctx, newId('pln'), newId('asg'), 'paused')));
    await expect(second).rejects.toThrow();
  });
});

describe('playbooks contracts', () => {
  it('names the keys and page sections', () => {
    expect(BRIEF_KEYS).toEqual(['overview', 'approach', 'value_angle', 'risks', 'why_now']);
    expect(PAGE_SECTIONS).toEqual([
      { key: 'overview', title: 'Overview' },
      { key: 'approach', title: 'Approach' },
      { key: 'value_angle', title: 'Value angle' },
      { key: 'risks', title: 'Risks' },
    ]);
    expect(SECTION_MAX).toBe(4000);
  });

  it('the job and event schemas parse a valid sample and reject a missing accountId', () => {
    expect(briefDraftJob.name).toBe('playbooks.brief.draft');
    expect(briefDraftJob.opts).toMatchObject({ maxDeliver: 3, timeoutMs: 240_000 });
    expect(briefDraftJob.data.safeParse({ accountId: 'acc_1', manual: false, includeEdited: [] }).success).toBe(true);
    expect(briefDraftJob.data.safeParse({ manual: false, includeEdited: [] }).success).toBe(false);
    expect(briefUpdated.type).toBe('playbooks.brief.updated');
    expect(briefUpdated.data.safeParse({ accountId: 'acc_1', sectionKeys: ['overview'], origin: 'human', mode: null }).success).toBe(true);
    expect(briefUpdated.data.safeParse({ accountId: 'acc_1', sectionKeys: ['overview'], origin: 'ai', mode: 'mock' }).success).toBe(true);
    expect(briefUpdated.data.safeParse({ sectionKeys: [], origin: 'rules', mode: 'rules' }).success).toBe(false);
  });
});
