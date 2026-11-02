import { afterAll } from 'vitest';
import { closeWorkspacePools } from '@/platform/db/doors';
import { superuserSql } from './db';

// Import this first in a test file: the file runs with SCOUT_WORKSPACE_DATABASES=per_workspace (D35).
// The config is read on first use, after this runs; it is set back for the next file (one process runs
// every file in turn).
const before = { mode: process.env.SCOUT_WORKSPACE_DATABASES, template: process.env.SCOUT_WORKSPACE_TEMPLATE_DATABASE };
process.env.SCOUT_WORKSPACE_DATABASES = 'per_workspace';
// Its own template name: the test server may also hold a development scout_t_template.
export const TEST_TEMPLATE = `scout_test_${process.pid}_template`;
process.env.SCOUT_WORKSPACE_TEMPLATE_DATABASE = TEST_TEMPLATE;

const made = new Set<string>([TEST_TEMPLATE]);

/** Drops `database` when this file is done (a workspace database a test made). */
export function dropAfter(database: string): void {
  made.add(database);
}

afterAll(async () => {
  await closeWorkspacePools();
  const su = superuserSql();
  try {
    for (const name of made) {
      await su.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await su.end({ timeout: 1 });
  }
  for (const [k, v] of [
    ['SCOUT_WORKSPACE_DATABASES', before.mode],
    ['SCOUT_WORKSPACE_TEMPLATE_DATABASE', before.template],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
