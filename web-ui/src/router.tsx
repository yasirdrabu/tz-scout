import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserHistory, createRouter, RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { ApiError, UnauthorizedError } from './api/errors';
import { adminAiRunsRoute, adminHealthRoute, adminIndexRoute, adminRoute, adminTenantsRoute } from './routes/admin';
import { homeRoute } from './routes/home';
import { LoadError } from './routes/LoadError';
import { rootRoute } from './routes/root';
import { profileRoute } from './routes/profile';
import { settingsRoute } from './routes/settings';
import { signinRoute } from './routes/signin';
import { tenantIndexRoute, tenantRoute } from './routes/tenant';
import {
  accountRoute,
  accountsRoute,
  batchesRoute,
  costsRoute,
  funnelRoute,
  myRoute,
  offersRoute,
  overviewRoute,
  playbooksRoute,
  queueRoute,
  sourcesRoute,
} from './routes/workspace';
import { ToastProvider } from './ui/Toast';

const routeTree = rootRoute.addChildren([
  homeRoute,
  signinRoute,
  tenantRoute.addChildren([
    tenantIndexRoute,
    queueRoute,
    myRoute,
    accountsRoute,
    accountRoute,
    overviewRoute,
    sourcesRoute,
    batchesRoute,
    offersRoute,
    playbooksRoute,
    funnelRoute,
    costsRoute,
    settingsRoute,
    profileRoute,
  ]),
  adminRoute.addChildren([adminIndexRoute, adminTenantsRoute, adminHealthRoute, adminAiRunsRoute]),
]);

function makeRouter(history: RouterHistory, queryClient: QueryClient) {
  return createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultErrorComponent: LoadError,
    defaultPreload: 'intent',
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof makeRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

export type App = { router: AppRouter; queryClient: QueryClient };

/** A 4xx will not change on retry; anything else is retried `times` times. */
const retryUnless4xx = (times: number) => (failures: number, error: unknown) =>
  failures < times && !(error instanceof ApiError && error.status >= 400 && error.status < 500);

/**
 * The router and query cache, wired together: a 401 from any query after the page has loaded sends
 * the person to sign-in with the path they were on. (Route guards handle a 401 while loading.)
 */
export function createApp({ history = createBrowserHistory(), retry = 1 }: { history?: RouterHistory; retry?: number | false } = {}): App {
  const app = {} as App;
  app.queryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        const { router } = app;
        if (!(error instanceof UnauthorizedError) || router.state.isLoading) return;
        const here = router.state.location;
        if (here.pathname === '/signin') return;
        void router.navigate({ to: '/signin', search: { return: here.href } });
      },
    }),
    defaultOptions: { queries: { retry: retry === false ? false : retryUnless4xx(retry) } },
  });
  app.router = makeRouter(history, app.queryClient);
  return app;
}

export function AppRoot({ app }: { app: App }) {
  return (
    <QueryClientProvider client={app.queryClient}>
      <ToastProvider>
        <RouterProvider router={app.router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
