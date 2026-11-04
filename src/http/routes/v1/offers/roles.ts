import { listBuyingRoles } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';

type Roles = { targetBuyingRoles?: string[]; optionalBuyingRoles?: string[] };

const bad = (path: string, message: string) =>
  new ScoutError({ slug: 'validation', status: 400, title: 'Check the offer.', errors: [{ path, message }] });

/**
 * Checks required and optional buying roles against the workspace's roles, and that no role is in both.
 * `stored` is the offer's current lists (patch): the overlap check sees the merged result, and a key the
 * offer already holds stays valid even if the role has since been archived.
 */
export async function checkBuyingRoles(ctx: ModuleContext, input: Roles, stored: Roles = {}): Promise<void> {
  if (input.targetBuyingRoles === undefined && input.optionalBuyingRoles === undefined) return;
  const labels = new Map((await listBuyingRoles(ctx)).map((r) => [r.key, r.label]));
  for (const [path, list] of [
    ['target_buying_roles', input.targetBuyingRoles],
    ['optional_buying_roles', input.optionalBuyingRoles],
  ] as const) {
    const held = [...(stored.targetBuyingRoles ?? []), ...(stored.optionalBuyingRoles ?? [])];
    const unknown = list?.find((k) => !labels.has(k) && !held.includes(k));
    if (unknown !== undefined) throw bad(path, `Unknown buying role: ${unknown}`);
  }
  const required = input.targetBuyingRoles ?? stored.targetBuyingRoles ?? [];
  const optional = input.optionalBuyingRoles ?? stored.optionalBuyingRoles ?? [];
  const both = required.find((k) => optional.includes(k));
  if (both !== undefined) throw bad('optional_buying_roles', `A role can't be both required and optional: ${labels.get(both) ?? both}`);
}
