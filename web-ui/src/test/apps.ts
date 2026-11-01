import type { App } from '../router';

/** Every app a test rendered, so setup can settle it once the test ends. */
export const renderedApps = new Set<App>();

const SETTLE_LIMIT_MS = 2000;

/** Waits (up to 2 s) for a route load or navigation the test started but did not await. */
async function routerSettled({ router }: App): Promise<void> {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  while ((router.state.isLoading || router.state.status !== 'idle') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Lets each app's router finish what it started, then cancels in-flight queries and empties the
 * cache. Without this, a route load or request that finishes after the file's jsdom environment is
 * gone throws "window is not defined".
 */
export async function settleRenderedApps(): Promise<void> {
  await Promise.all([...renderedApps].map(routerSettled));
}

export async function stopRenderedApps(): Promise<void> {
  const apps = [...renderedApps];
  renderedApps.clear();
  await Promise.all(
    apps.map(async ({ queryClient }) => {
      await queryClient.cancelQueries();
      queryClient.clear();
    }),
  );
}
