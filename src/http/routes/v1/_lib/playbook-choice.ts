import { getTemplate } from '@/modules/playbooks';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';

const unavailable = () =>
  new ScoutError({ slug: 'validation', status: 400, title: "That playbook isn't available.", errors: [{ path: 'playbook_id', message: "That playbook isn't available." }] });

/**
 * The assigner's playbook choice as routing takes it. Absent (undefined) is "no choice yet"; null is "no playbook";
 * a string must be a template that exists and is not archived, else 400.
 */
export async function playbookChoice(ctx: ModuleContext, playbookId: string | null | undefined): Promise<{ templateId?: string; noPlaybook?: boolean }> {
  if (playbookId === undefined) return {};
  if (playbookId === null) return { noPlaybook: true };
  const t = await getTemplate(ctx, playbookId).catch((e: unknown) => {
    if (e instanceof ScoutError && e.status === 404) return null;
    throw e;
  });
  if (!t || t.status === 'archived') throw unavailable();
  return { templateId: playbookId };
}
