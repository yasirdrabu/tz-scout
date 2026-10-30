import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseHubSpotWebhook, verifyHubSpotV3 } from '@/modules/crm/domain/webhook';

// The signature is built here from HubSpot v3 recipe (HMAC-SHA256 of method + url + body + timestamp, base64),
// not by the code under test.
const secret = 'client-secret';
const method = 'POST';
const url = 'https://scout.example.com/v1/inbound/hubspot/con_1';
const rawBody = '[{"subscriptionType":"deal.creation","objectId":123}]';
const now = new Date('2026-10-30T12:00:00Z');
const sign = (body: string, ts: string) => createHmac('sha256', secret).update(`${method}${url}${body}${ts}`).digest('base64');
const stamp = (msAgo: number) => String(now.getTime() - msAgo);

describe('verifyHubSpotV3', () => {
  it('accepts a correct signature', () => {
    const timestamp = stamp(1000);
    expect(verifyHubSpotV3(secret, { method, url, rawBody, timestamp, signature: sign(rawBody, timestamp) }, now)).toBe(true);
  });

  it('refuses a changed body', () => {
    const timestamp = stamp(1000);
    expect(verifyHubSpotV3(secret, { method, url, rawBody: rawBody + ' ', timestamp, signature: sign(rawBody, timestamp) }, now)).toBe(false);
  });

  it('refuses a wrong secret and a garbage signature', () => {
    const timestamp = stamp(1000);
    expect(verifyHubSpotV3('other', { method, url, rawBody, timestamp, signature: sign(rawBody, timestamp) }, now)).toBe(false);
    expect(verifyHubSpotV3(secret, { method, url, rawBody, timestamp, signature: 'x' }, now)).toBe(false);
  });

  it('refuses a 6-minute-old timestamp even when the signature matches, and accepts 4 minutes', () => {
    const old = stamp(6 * 60_000);
    expect(verifyHubSpotV3(secret, { method, url, rawBody, timestamp: old, signature: sign(rawBody, old) }, now)).toBe(false);
    const ok = stamp(4 * 60_000);
    expect(verifyHubSpotV3(secret, { method, url, rawBody, timestamp: ok, signature: sign(rawBody, ok) }, now)).toBe(true);
  });

  it('refuses a timestamp that is not a number', () => {
    expect(verifyHubSpotV3(secret, { method, url, rawBody, timestamp: 'soon', signature: sign(rawBody, 'soon') }, now)).toBe(false);
  });
});

describe('parseHubSpotWebhook', () => {
  it('maps deal, engagement and contact events', () => {
    const body = JSON.stringify([
      { subscriptionType: 'deal.propertyChange', objectId: 5, propertyName: 'dealstage', propertyValue: 'closedwon' },
      { subscriptionType: 'engagement.creation', objectId: 6 },
      { subscriptionType: 'contact.propertyChange', objectId: 7, propertyName: 'lifecyclestage', propertyValue: 'marketingqualifiedlead' },
      { subscriptionType: 'ticket.creation', objectId: 8 },
    ]);
    expect(parseHubSpotWebhook(body)).toEqual([
      { kind: 'deal', objectId: '5' },
      { kind: 'activity', objectId: '6' },
      { kind: 'lifecycle', objectId: '7', contactId: '7', propertyName: 'lifecyclestage', propertyValue: 'marketingqualifiedlead' },
    ]);
  });

  it('returns nothing for a body that is not a list of events', () => {
    expect(parseHubSpotWebhook('not json')).toEqual([]);
    expect(parseHubSpotWebhook('{"a":1}')).toEqual([]);
  });
});
