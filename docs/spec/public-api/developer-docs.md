# API-E4 Developer docs page

Release R1

## Rules

- `/api/v1/openapi.json` is generated at build time from the Zod contracts of every module's `http/` and
  committed as a snapshot; CI fails if the generated spec changes without the snapshot being updated
  (so API changes are always reviewed).
- `/developers` is a public page (no sign-in needed to read) rendering the OpenAPI spec with a
  reference viewer (Scalar or Redoc, loaded locally, not from a CDN), plus written guides:
  - Getting a key, and what scopes mean.
  - Send your first account (curl, Node, Python).
  - Send a batch and follow up.
  - Connect Claude or ChatGPT through MCP (hosted URL and local package).
  - Webhooks and signature checks.
  - Errors and retries.
- Examples use the sandbox and test keys only.

## Stories

### API-E4-S1 Read the reference
As an agent builder, I want an accurate reference with examples for every endpoint, so that I can
build without asking Taazaa.
- API-E4-S1-AC1 Every endpoint in public-api/index.md appears with request and response examples.
- API-E4-S1-AC2 The snapshot check fails CI when a handler's schema changes without updating the spec.

### API-E4-S2 First call in five minutes
As a new partner, I want a short guide from key to first accepted account, so that I see it work fast.
- API-E4-S2-AC1 Following the guide with a test key produces a resolved arrival in the sandbox.
