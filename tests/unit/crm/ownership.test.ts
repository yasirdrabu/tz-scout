import { describe, expect, it } from 'vitest';
import { decideOwnership, type OwnershipInput } from '@/modules/crm/domain/ownership';

const base: OwnershipInput = {
  existing: { ownerId: 'o-other', lifecycle: 'lead', openDeals: 0 },
  ownerId: 'o-me',
  pushedOwnerId: null,
  currentOwnerActive: true,
  takeOver: true,
  allowOtherOwner: false,
};
const decide = (over: Partial<OwnershipInput>) => decideOwnership({ ...base, ...over });

describe('decideOwnership (CRM-E3 table)', () => {
  it('assigns when the company is not in the CRM', () => {
    expect(decide({ existing: null })).toEqual({ action: 'assign', replaceOwnerId: null, takenFrom: null });
  });
  it('assigns when the company has no owner', () => {
    expect(decide({ existing: { ownerId: null, lifecycle: null, openDeals: 0 } })).toEqual({ action: 'assign', replaceOwnerId: null, takenFrom: null });
  });
  it('assigns when the seller already owns it', () => {
    expect(decide({ existing: { ownerId: 'o-me', lifecycle: 'customer', openDeals: 2 } })).toEqual({ action: 'assign', replaceOwnerId: 'o-me', takenFrom: null });
  });
  it('assigns when the owner is the one we set last time, even with an open deal', () => {
    expect(decide({ pushedOwnerId: 'o-other', existing: { ownerId: 'o-other', lifecycle: 'customer', openDeals: 1 } })).toEqual({ action: 'assign', replaceOwnerId: 'o-other', takenFrom: null });
  });
  it('stops on an open deal', () => {
    expect(decide({ existing: { ownerId: 'o-other', lifecycle: 'lead', openDeals: 1 } })).toEqual({ action: 'stop', reason: 'has an open deal' });
  });
  it('stops on a customer', () => {
    expect(decide({ existing: { ownerId: 'o-other', lifecycle: 'customer', openDeals: 0 } })).toEqual({ action: 'stop', reason: 'is a customer' });
  });
  it('takes over an active owner when the setting is on', () => {
    expect(decide({})).toEqual({ action: 'assign', replaceOwnerId: 'o-other', takenFrom: 'o-other' });
  });
  it('takes over an inactive owner even with the setting off', () => {
    expect(decide({ takeOver: false, currentOwnerActive: false })).toEqual({ action: 'assign', replaceOwnerId: 'o-other', takenFrom: 'o-other' });
  });
  it('stops on an active owner when the setting is off', () => {
    expect(decide({ takeOver: false })).toEqual({ action: 'stop', reason: 'is owned by someone else' });
  });
  it('stops on an unknown owner status when the setting is off', () => {
    expect(decide({ takeOver: false, currentOwnerActive: null })).toEqual({ action: 'stop', reason: 'is owned by someone else' });
  });
  it('keeps their owner on "push anyway"', () => {
    expect(decide({ allowOtherOwner: true })).toEqual({ action: 'keep', reason: 'pushed with their ownership kept' });
    expect(decide({ allowOtherOwner: true, existing: { ownerId: 'o-other', lifecycle: 'customer', openDeals: 0 } })).toEqual({ action: 'keep', reason: 'is a customer' });
  });
});
