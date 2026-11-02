import { inArray } from 'drizzle-orm';
import { afterAll } from 'vitest';
import { workspaceInfra } from '@/modules/tenancy/db/schema';
import { controlAdminDb } from '@/platform/db/client';
import { closeWorkspacePools } from '@/platform/db/doors';
import { superuserSql } from './db';

// Import this first in a test file: its workspaces are made the real way (D35), each provisioned into
// a database of its own, not placed in the file's shared test workspace database
// (workspace-per-file.ts). It is set back for the next file (one process runs every file in turn).
const before = { mode: process.env.SCOUT_WORKSPACE_DATABASES, own: process.env.SCOUT_TEST_WORKSPACES };
process.env.SCOUT_WORKSPACE_DATABASES = 'per_workspace';
process.env.SCOUT_TEST_WORKSPACES = 'own';
/** The run's template workspace database (setup.ts). */
export const TEST_TEMPLATE = process.env.SCOUT_WORKSPACE_TEMPLATE_DATABASE ?? `scout_test_${process.pid}_template`;

const made = new Set<string>();

/** Drops `database` when this file is done (a workspace database a test made). */
export function dropAfter(database: string): void {
  made.add(database);
}

afterAll(async () => {
  await closeWorkspacePools();
  const su = superuserSql();
  try {
    for (const name of made) await su.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await su.end({ timeout: 1 });
  }
  // Their registry rows stay in the run's control plane: mark them deleted, as a real delete would,
  // so later files' cross-workspace reads do not look for them.
  if (made.size > 0) await controlAdminDb.update(workspaceInfra).set({ status: 'deleted' }).where(inArray(workspaceInfra.database, [...made]));
  for (const [k, v] of [
    ['SCOUT_WORKSPACE_DATABASES', before.mode],
    ['SCOUT_TEST_WORKSPACES', before.own],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
