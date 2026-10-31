import { afterAll } from 'vitest';
import { closeDbs } from '@/platform/db/client';

// Every test file re-imports the modules and so gets fresh pools; close them so a full run
// stays under the server's connection limit.
afterAll(closeDbs);
