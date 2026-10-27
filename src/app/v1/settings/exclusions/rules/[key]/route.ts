import { z } from 'zod';
import { listExclusionRules, setExclusionRule } from '@/modules/accounts';
import { parseBody } from '../../../../_lib/body';
import { idAndAction, notFound } from '../../../../_lib/path';
import { v1Route } from '../../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const ruleBody = z.strictObject({ enabled: z.boolean() });

export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id: key, action } = idAndAction(req, 'rules');
  if (action) throw notFound();
  await setExclusionRule(ctx, key, (await parseBody<{ enabled: boolean }>(req, ruleBody)).enabled);
  return (await listExclusionRules(ctx)).find((r) => r.key === key)!;
});
