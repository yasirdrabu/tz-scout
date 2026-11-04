import { nextSteps } from '@/modules/playbooks';
import { can, type Principal } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';

type Fields = { title: string; dueDate: string; overdue: boolean; dueToday: boolean };

/** With no `playbooks:read` the map is empty (both fields null). `next_step` and `playbook_name` for list rows, from playbooks (routing cannot import it): one `nextSteps` call for the page. */
export async function planFields(ctx: ModuleContext, principal: Principal, accountIds: string[]): Promise<Map<string, { nextStep: Fields | null; playbookName: string }>> {
  if (!can(principal, 'playbooks:read')) return new Map();
  const found = await nextSteps(ctx, [...new Set(accountIds)]);
  return new Map([...found].map(([id, s]) => [id, { nextStep: s.nextStep && { title: s.nextStep.title, dueDate: s.nextStep.dueDate, overdue: s.nextStep.overdue, dueToday: s.nextStep.dueToday }, playbookName: s.playbookName }]));
}
