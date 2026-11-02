import { afterAll } from 'vitest';

// Import this first in a test file: it runs with SCOUT_WORKSPACE_DATABASES=shared, every workspace in
// the control plane's database (the mode the move tool starts from). Set back for the next file.
const before = process.env.SCOUT_WORKSPACE_DATABASES;
process.env.SCOUT_WORKSPACE_DATABASES = 'shared';

afterAll(() => {
  if (before === undefined) delete process.env.SCOUT_WORKSPACE_DATABASES;
  else process.env.SCOUT_WORKSPACE_DATABASES = before;
});
