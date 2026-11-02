import { expect, it } from 'vitest';
import { admitted } from '@/platform/db/admission';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

it('runs at most pool size - 1 top-level transactions at once; nested ones go straight in (D35)', async () => {
  let outer = 0;
  let maxOuter = 0;
  let nested = 0;
  const run = () =>
    admitted('scout_t_a', 3, async () => {
      outer++;
      maxOuter = Math.max(maxOuter, outer);
      await tick();
      // A nested transaction on the same pool is not queued behind the others.
      await admitted('scout_t_a', 3, async () => {
        nested++;
        await tick();
      });
      outer--;
    });
  await Promise.all(Array.from({ length: 10 }, run));
  expect(maxOuter).toBe(2);
  expect(nested).toBe(10);
});

it('pools do not wait on each other, and a pool of 1 still runs one at a time', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = admitted('scout_t_a', 1, async () => {
    order.push('a in');
    await gate;
  });
  await admitted('scout_t_b', 1, async () => void order.push('b in'));
  const a2 = admitted('scout_t_a', 1, async () => void order.push('a2 in'));
  await tick();
  expect(order).toEqual(['a in', 'b in']);
  release();
  await Promise.all([a, a2]);
  expect(order).toEqual(['a in', 'b in', 'a2 in']);
});
