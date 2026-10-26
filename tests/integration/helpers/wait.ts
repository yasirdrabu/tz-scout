export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` every 25 ms until it returns true, or throws after `ms`. */
export async function waitFor(fn: () => Promise<boolean> | boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting');
}
