import { nextSteps } from '@/modules/playbooks';
import type { ModuleContext } from '@/platform/context';

type Fields = { title: string; dueDate: string; overdue: boolean; dueToday: boolean };

/** `next_step` and `playbook_name` for list rows, from playbooks (routing cannot import it): one `nextSteps` call for the page. */
export async function planFields(ctx: ModuleContext, accountIds: string[]): Promise<Map<string, { nextStep: Fields; playbookName: string }>> {
  const found = await nextSteps(ctx, [...new Set(accountIds)]);
  return new Map([...found].map(([id, s]) => [id, { nextStep: { title: s.title, dueDate: s.dueDate, overdue: s.overdue, dueToday: s.dueToday }, playbookName: s.playbookName }]));
}
