import postgres from 'postgres';
import { afterAll, beforeAll } from 'vitest';
import { setTestDbs } from '@/platform/db/client';
import { closeWorkspacePools, registerWorkspaceLookup } from '@/platform/db/doors';
import { createDatabase } from '@/platform/db/migrate';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import { routedDb } from './helpers/db-router';
import { superuserSql } from './helpers/db';

// D35, per_workspace mode (the default): each test file gets a workspace database of its own, copied
// from the run's template, and the tenants it creates are placed in it (open at once, no provisioning
// job); a tenant id a test makes up, with no registry row, is in it too. `adminDb` and `appDb` route
// each statement to the control plane or that database (helpers/db-router.ts). A file that makes
// workspaces the real way (helpers/per-workspace.ts) or runs in shared mode (helpers/shared-mode.ts)
// opts out. Reads the environment, not `config`: a test file may still change it before first use.

let database: string | undefined;
let clients: postgres.Sql[] = [];

beforeAll(async () => {
  const mode = process.env.SCOUT_WORKSPACE_DATABASES ?? 'per_workspace';
  if (process.env.SCOUT_TEST_WORKSPACES === 'own' || mode !== 'per_workspace') return;
  const adminUrl = process.env.DATABASE_ADMIN_URL!;
  const appUrl = process.env.DATABASE_URL!;
  const name = `scout_test_${process.pid}_f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  database = name;
  // Here, not at the top: a test file's vi.mock (of the config, say) must apply to the app's modules.
  const { placeNewWorkspaces, workspaceInfo, workspaceList } = await import('@/modules/tenancy');
  await createDatabase(name, process.env.SCOUT_WORKSPACE_TEMPLATE_DATABASE, adminUrl);
  placeNewWorkspaces(() => ({ database: name }));
  // The file's database is listed too, so the relay, scheduler and admin reads find what made-up tenants wrote there.
  registerWorkspaceLookup(
    async (tenantId) => (await workspaceInfo(tenantId)) ?? { status: 'active', database: name },
    async () => [...(await workspaceList()), { tenantId: 't_test_file', status: 'active', database: name }],
  );
  const open = (url: string) => postgres(url, { max: 10, onnotice: () => {} });
  const [controlAdmin, workspaceAdmin, controlApp, workspaceApp] = (clients = [
    open(adminUrl),
    open(urlForDatabase(adminUrl, name)),
    open(appUrl),
    open(urlForDatabase(appUrl, name)),
  ]);
  setTestDbs({ admin: routedDb(controlAdmin!, workspaceAdmin!), app: routedDb(controlApp!, workspaceApp!) });
});

afterAll(async () => {
  if (!database) return;
  (await import('@/modules/tenancy')).placeNewWorkspaces(undefined);
  setTestDbs({});
  // Its tenants' registry rows stay in the run's control plane: deleted, as a real delete would leave
  // them, so later files' cross-workspace reads do not look for the database. On this file's own
  // connection: the test file may have closed the app's pools already.
  await clients[0]!`update tenancy.workspace_infra set status = 'deleted' where database = ${database}`;
  await Promise.allSettled(clients.map((c) => c.end({ timeout: 1 })));
  await closeWorkspacePools();
  const su = superuserSql();
  try {
    await su.unsafe(`drop database if exists "${database}" with (force)`);
  } finally {
    await su.end({ timeout: 1 });
  }
});
