# MCP: MCP server

Module code MCP · No schema · Release R1

## Purpose

Let AI agents (Claude, ChatGPT, an AE's own research agent) send accounts to Scout, enrich them and
follow up, through tools designed for a model to use well. Same rules as the API: same services,
scopes, data limits, caps and audit (D8).

## Two ways to connect

| | Hosted | Local |
|---|---|---|
| How | Streamable HTTP at `https://scout.taazaa.ai/mcp` | `npx @taazaa/scout-mcp` (stdio) |
| Auth | OAuth 2.1 (authorization code + PKCE), member signs in with Microsoft and picks a source | API key in `SCOUT_API_KEY` |
| Calls | module services directly, inside the web role | `/v1` over HTTPS |
| Good for | Claude.ai, ChatGPT, any remote MCP client | Claude Code, Claude Desktop, scripts, CI, environments without browser sign-in |

Both expose the same tool list and the same tool schemas. The local package is generated from the same
contracts so they can't drift.

## Depends on

TEN (OAuth, principal), the public interfaces of SRC, ACC, REV, SCO, ENR, OFF, PLB.

## Epics

| Epic | File | Release |
|---|---|---|
| MCP-E1 Hosted and local servers | [hosted-and-local-servers.md](hosted-and-local-servers.md) | R1 |
| MCP-E2 Agent tools | [agent-tools.md](agent-tools.md) | R1 (R2 for brief and enrichment tools) |

## Tools

| Tool | Scopes | Module |
|---|---|---|
| `submit_account` | `arrivals:write` | SRC |
| `submit_batch` | `arrivals:write` | SRC |
| `get_batch_status` | `arrivals:read` | SRC |
| `list_my_submissions` | `arrivals:read` | SRC |
| `get_account_status` | `status:read` | REV |
| `find_accounts` | `accounts:read` | ACC |
| `get_account_brief` | `playbooks:read` | PLB |
| `explain_score` | `accounts:read` | SCO |
| `add_person` | `people:write` | ACC |
| `add_signal` | `signals:write` | ACC |
| `flag_for_enrichment` | `enrichment:request` | ENR |
| `list_offers` | `offers:read` | OFF |
| `get_source_performance` | own source always; others `analytics:read` | ANL |

Tools the principal lacks scopes for are not listed to it (`tools/list` is filtered), so a model never
sees tools it can't use.

## Resources and prompts

- Resource `scout://whoami`: tenant, source, scopes, caps and usage today (same as `GET /v1/me`).
- Resource `scout://offers`: practices and approved offers with target buyers, for agents to aim at.
- Prompt `research_and_submit`: a short template that tells an agent how to research a company against
  an offer and submit it with dated, linked signals.

## Events

None of its own. Tool calls produce the owning modules' events, with actor kind `agent` and the
OAuth grant or key id.

## Open questions

- ChatGPT's connector requirements change often; verify OAuth discovery and dynamic registration
  against the current spec at build time.
