import { expect, it } from 'vitest';
import { PROVIDERS, defaultRates } from '@/modules/integrations';
import { CATEGORY_OF_PROVIDER, DEFAULT_CENTS_PER_CREDIT } from '@/modules/integrations/contracts/costs';

it('every provider integrations can price has a cost category', () => {
  const priced = new Set([...PROVIDERS.map((p) => p.key).filter((k) => defaultRates(k, {}).length > 0), ...Object.keys(DEFAULT_CENTS_PER_CREDIT), 'anthropic']);
  for (const p of priced) expect(CATEGORY_OF_PROVIDER[p], p).toBeDefined();
});
