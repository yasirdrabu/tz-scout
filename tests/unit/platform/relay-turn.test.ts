import { describe, expect, it } from 'vitest';
import { relayTurn, type OutboxRow, type OutboxSource, type SourceHealth } from '@/platform/relay';

/** A fake database outbox holding `ids` in order; `broken` makes reads fail. */
function fakeOutbox(name: string, ids: string[], opts: { broken?: () => boolean } = {}) {
  const rows: OutboxRow[] = ids.map((id, i) => ({ seq: i + 1, id, nats_subject: `s.${name}`, payload: { id } }));
  const sent = new Set<string>();
  const source: OutboxSource = {
    name,
    unsent: async (limit) => {
      if (opts.broken?.()) throw new Error(`${name} is down`);
      return rows.filter((r) => !sent.has(r.id)).slice(0, limit);
    },
    markSent: async (marked) => {
      for (const id of marked) sent.add(id);
    },
  };
  return { source, sent };
}

describe('relayTurn: one turn over every database outbox (D35)', () => {
  it('takes one batch from each database in turn and keeps each database in order', async () => {
    const a = fakeOutbox('control', ['a1', 'a2', 'a3', 'a4', 'a5']);
    const b = fakeOutbox('t_1', ['b1', 'b2']);
    const published: string[] = [];
    const health: SourceHealth = new Map();
    const publish = async (r: OutboxRow) => void published.push(r.id);

    expect(await relayTurn([a.source, b.source], health, publish, { batchSize: 2 })).toEqual({ sentAny: true, full: true });
    expect(published).toEqual(['a1', 'a2', 'b1', 'b2']);
    await relayTurn([a.source, b.source], health, publish, { batchSize: 2 });
    await relayTurn([a.source, b.source], health, publish, { batchSize: 2 });
    expect(published).toEqual(['a1', 'a2', 'b1', 'b2', 'a3', 'a4', 'a5']);
    expect(await relayTurn([a.source, b.source], health, publish, { batchSize: 2 })).toEqual({ sentAny: false, full: false });
  });

  it('skips a broken database with a backoff, goes on with the others, and comes back to it', async () => {
    let down = true;
    const broken = fakeOutbox('t_broken', ['x1'], { broken: () => down });
    const ok = fakeOutbox('t_ok', ['y1', 'y2']);
    const published: string[] = [];
    const health: SourceHealth = new Map();
    const publish = async (r: OutboxRow) => void published.push(r.id);

    await relayTurn([broken.source, ok.source], health, publish, { batchSize: 1, now: 0 });
    expect(published).toEqual(['y1']);
    expect(health.get('t_broken')).toEqual({ failures: 1, retryAt: 1000 });
    // Still within the backoff: not even asked, even though it is back.
    down = false;
    await relayTurn([broken.source, ok.source], health, publish, { batchSize: 1, now: 500 });
    expect(published).toEqual(['y1', 'y2']);
    await relayTurn([broken.source, ok.source], health, publish, { batchSize: 1, now: 1000 });
    expect(published).toEqual(['y1', 'y2', 'x1']);
    expect(health.has('t_broken')).toBe(false);
  });

  it('doubles the backoff while a database stays broken, up to a minute', async () => {
    const broken = fakeOutbox('t_broken', ['x1'], { broken: () => true });
    const health: SourceHealth = new Map();
    let now = 0;
    for (let i = 0; i < 9; i++) {
      now = health.get('t_broken')?.retryAt ?? now;
      await relayTurn([broken.source], health, async () => {}, { batchSize: 1, now });
    }
    expect(health.get('t_broken')!.failures).toBe(9);
    expect(health.get('t_broken')!.retryAt - now).toBe(60_000);
  });

  it('with NATS down, a publish failure marks what was sent, stops the turn and is thrown', async () => {
    const a = fakeOutbox('control', ['a1', 'a2']);
    const b = fakeOutbox('t_1', ['b1']);
    let calls = 0;
    const publish = async () => {
      if (++calls === 2) throw new Error('nats down');
    };
    await expect(relayTurn([a.source, b.source], new Map(), publish, { batchSize: 5, natsDown: () => true })).rejects.toThrow('nats down');
    expect([...a.sent]).toEqual(['a1']);
    expect(b.sent.size).toBe(0);
  });

  it('a row that never publishes holds back only its own database, with a backoff', async () => {
    const a = fakeOutbox('control', ['bad', 'a2']);
    const b = fakeOutbox('t_1', ['b1', 'b2']);
    const health: SourceHealth = new Map();
    const published: string[] = [];
    const publish = async (r: OutboxRow) => {
      if (r.id === 'bad') throw new Error('no stream matches subject');
      published.push(r.id);
    };
    for (const now of [0, 1, 2]) await relayTurn([a.source, b.source], health, publish, { batchSize: 1, now, natsDown: () => false });
    expect(published).toEqual(['b1', 'b2']);
    expect(a.sent.size).toBe(0);
    expect(health.get('control')).toEqual({ failures: 1, retryAt: 1000 });
  });

  it('publishing failing in three sources in a row ends the turn: NATS is probably the problem', async () => {
    const sources = ['s1', 's2', 's3', 's4'].map((n) => fakeOutbox(n, [`${n}-1`]));
    const publish = async () => {
      throw new Error('timeout');
    };
    await expect(relayTurn(sources.map((s) => s.source), new Map(), publish, { batchSize: 1, natsDown: () => false })).rejects.toThrow('timeout');
  });
});
