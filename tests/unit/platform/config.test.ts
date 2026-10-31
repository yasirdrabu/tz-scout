import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/platform/config';

const key = Buffer.alloc(32, 7).toString('base64');
const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://a',
  DATABASE_ADMIN_URL: 'postgres://b',
  NATS_URL: 'nats://n',
  AUTH_SECRET: 's',
  APP_PUBLIC_URL: 'https://x',
  SCOUT_MASTER_KEY: key,
};

describe('loadConfig', () => {
  it('rejects dev sign-in in production', () => {
    expect(() => loadConfig({ ...prod, AUTH_DEV_SIGNIN: 'true' })).toThrow(
      'AUTH_DEV_SIGNIN must be false in production',
    );
  });
  it('requires master key in production', () => {
    const { SCOUT_MASTER_KEY: _k, ...rest } = prod;
    expect(() => loadConfig(rest)).toThrow('SCOUT_MASTER_KEY is required in production');
  });
  it('rejects a bad master key', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', SCOUT_MASTER_KEY: 'abc' })).toThrow(
      'SCOUT_MASTER_KEY must be 32 bytes, base64',
    );
  });
  it('loads dev defaults and parses values', () => {
    const c = loadConfig({ NODE_ENV: 'development', SCOUT_MASTER_KEY: key, AUTH_DEV_SIGNIN: 'true' });
    expect(c.natsUrl).toBe('nats://localhost:4222');
    expect(c.masterKey?.length).toBe(32);
    expect(c.authDevSignin).toBe(true);
    expect(c.forceMock).toBe(false);
    expect(c.azureAd).toBeUndefined();
  });
  it('sets azureAd only when all three present', () => {
    expect(loadConfig({ AZURE_AD_TENANT_ID: 't', AZURE_AD_CLIENT_ID: 'c' }).azureAd).toBeUndefined();
    expect(
      loadConfig({ AZURE_AD_TENANT_ID: 't', AZURE_AD_CLIENT_ID: 'c', AZURE_AD_CLIENT_SECRET: 's' }).azureAd,
    ).toEqual({ tenantId: 't', clientId: 'c', clientSecret: 's', allowedTenantIds: [] });
  });
  it('allows email matching from the home tenant by default, or from AZURE_AD_ALLOWED_TENANT_IDS', () => {
    const home = '11111111-2222-3333-4444-555555555555';
    const other = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    const base = { AZURE_AD_TENANT_ID: home, AZURE_AD_CLIENT_ID: 'c', AZURE_AD_CLIENT_SECRET: 's' };
    expect(loadConfig(base).azureAd!.allowedTenantIds).toEqual([home]);
    expect(loadConfig({ ...base, AZURE_AD_ALLOWED_TENANT_IDS: `${home}, ${other}` }).azureAd!.allowedTenantIds).toEqual([
      home,
      other.toLowerCase(),
    ]);
    expect(() => loadConfig({ ...base, AZURE_AD_ALLOWED_TENANT_IDS: 'common' })).toThrow(/GUIDs/);
  });
  it('accepts production config', () => {
    expect(loadConfig(prod).nodeEnv).toBe('production');
  });
});

describe('.env.example', () => {
  it('loads without error when copied as is', () => {
    const env: Record<string, string> = {};
    for (const line of readFileSync('.env.example', 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      env[t.slice(0, i)] = t.slice(i + 1);
    }
    expect(() => loadConfig(env)).not.toThrow();
  });
});

describe('SCOUT_ENV', () => {
  it('lets a production NODE_ENV run as development (Next standalone forces NODE_ENV=production)', () => {
    const c = loadConfig({ NODE_ENV: 'production', SCOUT_ENV: 'development', AUTH_DEV_SIGNIN: 'true' });
    expect(c.isProduction).toBe(false);
    expect(c.authDevSignin).toBe(true);
  });
  it('applies production rules when SCOUT_ENV=production', () => {
    expect(() => loadConfig({ ...prod, SCOUT_ENV: 'production', AUTH_DEV_SIGNIN: 'true' })).toThrow(
      'AUTH_DEV_SIGNIN must be false in production',
    );
  });
  it('trusts no proxy hops unless SCOUT_TRUSTED_PROXY_HOPS says so', () => {
    expect(loadConfig({}).trustedProxyHops).toBe(0);
    expect(loadConfig({ SCOUT_TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops).toBe(2);
    expect(() => loadConfig({ SCOUT_TRUSTED_PROXY_HOPS: '-1' })).toThrow('SCOUT_TRUSTED_PROXY_HOPS');
  });
  it('falls back to NODE_ENV', () => {
    expect(loadConfig(prod).isProduction).toBe(true);
    expect(loadConfig({}).isProduction).toBe(false);
  });
});
