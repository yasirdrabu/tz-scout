# MCP-E1 Hosted and local servers

Release R1

## Rules

- **Hosted:** built with the official MCP TypeScript SDK, Streamable HTTP transport, mounted at `/mcp`
  in the web role. Stateless per request (no sticky sessions needed); session id header supported for
  clients that send it.
- **OAuth discovery:** `/.well-known/oauth-protected-resource` on the MCP URL points to Scout's
  authorization server metadata at `/.well-known/oauth-authorization-server`. Dynamic client
  registration at `/oauth/register` when the tenant allows it. Tenant is chosen at sign-in (a member of
  several tenants picks one); the token is bound to that tenant.
- Unauthenticated requests get 401 with `WWW-Authenticate` pointing to the resource metadata, so
  clients start the OAuth flow by themselves.
- **Local:** package `@taazaa/scout-mcp`, published to npm (public, MIT). Config: `SCOUT_API_KEY`
  (required), `SCOUT_BASE_URL` (default `https://scout.taazaa.ai`). It calls `/api/v1` and maps API errors
  to tool errors. Works with test keys against the sandbox.
- Tool errors are returned as tool results with `isError: true` and a short sentence the model can act
  on ("This account isn't one your source sent, so its details aren't available."), never stack traces.
- Every tool call is audited with tool name, principal, arguments summary (no contact details) and
  correlation id; the MCP session id is the correlation id prefix for calls in one conversation.
- Rate limits and caps are the same as the API's for that principal.

## Stories

### MCP-E1-S1 Connect Claude by URL
As an AE, I want to add Scout to Claude by pasting a URL and signing in, so that my research agent can
send accounts.
- MCP-E1-S1-AC1 Adding `https://scout.taazaa.ai/mcp` in Claude starts sign-in; after consent, Claude
  lists the tools my scopes allow.
- MCP-E1-S1-AC2 The grant appears under my connected apps with the source I picked.

### MCP-E1-S2 Run locally with a key
As a developer, I want a stdio server I can run with a key, so that Claude Code and scripts can use
Scout.
- MCP-E1-S2-AC1 `SCOUT_API_KEY=scout_test_... npx @taazaa/scout-mcp` lists the same tools as the hosted
  server for that key.
- MCP-E1-S2-AC2 A contract test compares the hosted and local tool lists and schemas and fails on any
  difference.

### MCP-E1-S3 Only usable tools are shown
- MCP-E1-S3-AC1 A grant without `people:write` does not see `add_person` in `tools/list`.
