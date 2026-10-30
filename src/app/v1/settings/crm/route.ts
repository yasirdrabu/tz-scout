import { z } from 'zod';
import { getCrmSettings, setCrmSettings, type CrmSettingsPatch } from '@/modules/crm';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

// The service checks every field and names its path, so a person gets the plain-words message for each.
const body = z.record(z.string(), z.unknown());

export const GET = v1Route({ permission: 'settings:manage' }, async (_req, _principal, ctx) => getCrmSettings(ctx));

export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) =>
  setCrmSettings(ctx, await parseBody<CrmSettingsPatch>(req, body)),
);
