// The recorded-input checks for `account_brief` in mock and rules (prompt-versions-and-checks.md). No live model.
import { describe, expect, it } from 'vitest';
import { DETAIL_MAX, HEADLINE_MAX, OPENER_MAX, SUBJECT_MAX } from '@/modules/playbooks/domain/brief-io';
import { isBuyerSafe } from '@/modules/playbooks/domain/buyer-safe';
import { SECTION_MAX } from '@/modules/playbooks/contracts/types';
import { accountBriefTask } from '@/modules/playbooks/tasks/account-brief';
import { BRIEF_FIXTURES } from './fixtures/briefs';

describe.each(Object.entries(BRIEF_FIXTURES))('account_brief checks: %s', (_name, input) => {
  const ids = new Set([...input.facts.map((f) => f.id), ...input.signals.map((s) => s.id), ...input.people.map((p) => p.id)]);

  it('the input parses and the prompt names every id', () => {
    const parsed = accountBriefTask.input.parse(input);
    const user = accountBriefTask.buildUser(parsed);
    for (const id of ids) expect(user).toContain(`[${id}]`);
    expect(accountBriefTask.system).not.toMatch(/—/);
  });

  for (const mode of ['rules', 'mock'] as const) {
    it(`${mode}: parses, cites only input ids, opens buyer safe, within limits`, () => {
      const out = accountBriefTask.output.parse(accountBriefTask[mode]!(input));
      for (const s of Object.values(out.sections)) {
        for (const c of s.citations) expect(ids, c).toContain(c);
        expect(s.text.length).toBeLessThanOrEqual(SECTION_MAX);
        expect(s.text).not.toMatch(/—/);
      }
      expect(isBuyerSafe(out.opener.body, input.signals)).toBe(true);
      expect(isBuyerSafe(out.opener.subject, input.signals)).toBe(true);
      expect(out.recommendation.headline.length).toBeLessThanOrEqual(HEADLINE_MAX);
      expect(out.recommendation.detail.length).toBeLessThanOrEqual(DETAIL_MAX);
      expect(out.opener.subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
      expect(out.opener.body.length).toBeLessThanOrEqual(OPENER_MAX);
      if (out.whoFirst.personId) expect(ids).toContain(out.whoFirst.personId);
    });
  }
});

describe('account_brief definition', () => {
  it('uses Sonnet 5.5 with a 10 cent cap', () => {
    expect(accountBriefTask).toMatchObject({ name: 'account_brief', promptVersion: 'v1.0', model: 'claude-sonnet-5-5', maxTokens: 3000, maxCostCents: 10 });
  });
});
