// The website reader's address guard (review I-1): which addresses are refused, and the connect-time lookup that
// checks every address a name resolves to. The resolver is stubbed, so nothing here touches the network.
import { describe, expect, it, vi } from 'vitest';
import { isBlockedAddress, isPublicHost, normaliseHost } from '@/modules/enrichment/adapters/website/guard';
import { guardedFetch, guardedLookup } from '@/modules/enrichment/adapters/website/live-transport';
import { classifyError } from '@/modules/enrichment/domain/errors';

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0', '10.0.0.5', '127.0.0.1', '100.64.0.1', '100.127.255.255', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', '::ffff:127.0.0.1', '::ffff:10.0.0.5',
    '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', 'ff02::1', 'not an address',
  ])('refuses %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.32.0.1', '2606:4700::1111', '::ffff:93.184.216.34'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('host names', () => {
  it('reads a domain as the URL parser does, so hex and decimal forms are addresses', () => {
    expect(normaliseHost('0x7f.1')).toBe('127.0.0.1');
    expect(normaliseHost('2130706433')).toBe('127.0.0.1');
    expect(normaliseHost('ACME.com')).toBe('acme.com');
    expect(normaliseHost('a.com@10.0.0.1')).toBeNull();
    expect(normaliseHost('acme.com:8443')).toBeNull();
    expect(isPublicHost(normaliseHost('0x7f.1')!)).toBe(false);
    expect(isPublicHost('acme.com')).toBe(true);
    expect(isPublicHost('[::1]')).toBe(false);
  });
});

const lookupOnce = (resolve: Parameters<typeof guardedLookup>[0], options: { all?: boolean; family?: number } = {}) =>
  new Promise<{ err: unknown; address: unknown; family?: number }>((done) =>
    guardedLookup(resolve)('looks-public.example', options, (err, address, family) => done({ err, address, family })),
  );

describe('the connect-time lookup', () => {
  it('refuses a public-looking name whose lookup returns 10.0.0.5', async () => {
    const r = await lookupOnce(async () => [{ address: '10.0.0.5', family: 4 }]);
    expect(r.err).toMatchObject({ status: 400, message: "looks-public.example isn't a public website." });
  });

  it('refuses the name when any one of its addresses is private', async () => {
    const r = await lookupOnce(async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }], { all: true });
    expect(r.err).toMatchObject({ status: 400 });
  });

  it('hands over public addresses, one or all as asked', async () => {
    const addrs = [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }];
    expect(await lookupOnce(async () => addrs)).toEqual({ err: null, address: '93.184.216.34', family: 4 });
    expect(await lookupOnce(async () => addrs, { all: true })).toEqual({ err: null, address: addrs, family: undefined });
    expect(await lookupOnce(async () => addrs, { family: 6 })).toEqual({ err: null, address: '2606:4700::1111', family: 6 });
  });

  it('a name with no address is not found', async () => {
    expect((await lookupOnce(async () => [])).err).toMatchObject({ code: 'ENOTFOUND' });
  });
});

describe('guardedFetch', () => {
  it('fails a request to a name that resolves privately, before connecting', async () => {
    const resolve = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }]);
    const e = await guardedFetch(resolve)('https://looks-public.example/', {}).catch((x: unknown) => x);
    expect(resolve).toHaveBeenCalledWith('looks-public.example');
    expect(e).toMatchObject({ status: 400 });
    expect(classifyError(e, 'Company website').kind).toBe('bad_request');
  });

  it('refuses an address in the URL without looking anything up', async () => {
    const resolve = vi.fn();
    for (const url of ['http://0x7f.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:7f00:1]/']) {
      await expect(guardedFetch(resolve)(url, {})).rejects.toMatchObject({ status: 400 });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reads only http and https', async () => {
    await expect(guardedFetch(vi.fn())('ftp://acme.com/', {})).rejects.toMatchObject({ status: 400 });
  });
});
