# Scout web app

The standalone React, Vite and TypeScript app for Taazaa Scout. Spec: `docs/spec/web-ui/index.md`.
It is its own npm package: nothing here imports from the backend's `src/`, and the backend never
imports from here.

## Run it

```sh
cd web-ui
npm install
npm run dev        # http://localhost:5173
```

The dev server proxies `/api` (the API at `/api/v1` and sign-in at `/api/auth`), `/healthz` and
`/readyz` to the backend at `http://localhost:4240`
(start it with `npm run dev` at the repo root). Set `SCOUT_BACKEND_URL` to use another backend.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on port 5173 with the proxy |
| `npm run build` | Type checks, then builds static files into `dist/` |
| `npm run preview` | Serves `dist/` |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | ESLint with typescript-eslint, react-hooks and jsx-a11y |
| `npm test` | Vitest once (jsdom, Testing Library, MSW) |
| `npm run test:watch` | Vitest in watch mode |

## Local dev and the backend's same-site check

The backend refuses cookie-authenticated writes whose `Origin` header is not the origin of
`APP_PUBLIC_URL` (`assertSameSite` in `src/http/routes/v1/_lib/v1-route.ts`). Locally that is
`http://localhost:4240`, but the browser sends `Origin: http://localhost:5173`. So the proxy in
`vite.config.ts` uses `changeOrigin: true` and rewrites the `Origin` header to the backend origin,
but only when it is the dev server's own origin; any other `Origin` is passed on unchanged.
Do not copy this to production: there the app and the API share one origin (spec W2), so no rewrite
is needed.

Sign in locally with developer sign-in (`AUTH_DEV_SIGNIN=true` on the backend). Microsoft sign-in
returns to `APP_PUBLIC_URL`, which is the backend's origin, not the Vite one. The backend has no pages
any more, so locally that return lands on a 404 until the backend learns the app's return paths. In
production the app and the API share one origin, so it lands in the app.

## Dependencies

Every version is pinned exactly (`.npmrc` sets `save-exact`). `.npmrc` also sets
`legacy-peer-deps`, because the `geist` font package lists `next` as a peer and this app only uses
its font files.
