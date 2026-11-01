import { describe, expect, it } from 'vitest';
import { bestMatch, type SellerCandidate } from '@/modules/routing/domain/best-match';

const names: Record<string, string> = { dt: 'Digital Transformation', ai: 'AI Transformation' };
const name = (id: string) => names[id] ?? id;
const seller = (userId: string, practices: string[] | 'all', activeAccounts: number, over: Partial<SellerCandidate> = {}): SellerCandidate => ({
  userId,
  name: userId.toUpperCase(),
  practices,
  activeAccounts,
  crmOwnerLinked: true,
  ...over,
});

describe('bestMatch (Decision 8)', () => {
  it('picks the seller covering the offer with the fewest active accounts, and says why', () => {
    const sellers = [seller('a', ['dt'], 6), seller('b', ['dt', 'ai'], 4), seller('c', ['ai'], 1)];
    expect(bestMatch(sellers, ['dt'], name)).toEqual({ userId: 'b', reason: 'Covers Digital Transformation and has the fewest active accounts (4).' });
  });

  it('needs every practice covered for several accounts; all practices covers them', () => {
    const sellers = [seller('a', ['dt'], 0), seller('b', 'all', 3), seller('c', ['dt', 'ai'], 5)];
    expect(bestMatch(sellers, ['dt', 'ai', 'dt'], name)).toEqual({ userId: 'b', reason: 'Covers Digital Transformation and AI Transformation and has the fewest active accounts (3).' });
  });

  it('skips a seller with no HubSpot user, and breaks ties by name', () => {
    const sellers = [seller('a', ['dt'], 0, { crmOwnerLinked: false }), seller('d', ['dt'], 2, { name: 'Zed' }), seller('e', ['dt'], 2, { name: 'Amy' })];
    expect(bestMatch(sellers, ['dt'], name)?.userId).toBe('e');
  });

  it('gives no badge when nobody covers the offer or an account has no best offer (Open question 7)', () => {
    expect(bestMatch([seller('a', ['ai'], 0)], ['dt'], name)).toBeNull();
    expect(bestMatch([seller('a', 'all', 0)], [], name)).toBeNull();
  });
});
