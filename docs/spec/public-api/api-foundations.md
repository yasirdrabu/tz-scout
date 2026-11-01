# API-E1 API foundations

Release R1

## Rules

**Versioning.** Path version `/api/v1`. Within `/api/v1`, only compatible changes: new endpoints, new optional
request fields, new response fields, new enum values (clients must ignore unknown values). Breaking
changes go to `/api/v2`, which runs alongside `/api/v1` for at least six months; `/api/v1` responses then carry
`Deprecation` and `Sunset` headers.

**Auth.** `Authorization: Bearer <api key or OAuth access token>`. Missing or bad token: 401. Valid
token without the scope: 403 naming the missing scope. Row outside the data limit: 404 (never reveal
that it exists).

**Requests.** JSON bodies, UTF-8, max 5 MB (batches up to 10 MB; files via the upload endpoint).
Unknown fields are rejected (400) so typos are caught.

**Idempotency.** Every `POST` accepts `Idempotency-Key` (up to 255 chars). Same key, same principal,
same body within 24 hours returns the stored status code and body with header `Idempotent-Replayed:
true`. Same key with a different body returns 409. Arrivals and batch items also take an optional
`external_ref` (the caller's own id); a second arrival from the same source with the same
`external_ref` returns the first arrival instead of creating a new one.

**Pagination.** `?limit` (1 to 200, default 50) and `?cursor`. Response `{ "data": [...],
"next_cursor": "..." | null }`. Cursors are opaque and stable under inserts.

**Errors.** `application/problem+json`:

```json
{
  "type": "https://scout.taazaa.ai/errors/validation",
  "title": "Some fields are not valid.",
  "status": 400,
  "detail": "2 problems in the request body.",
  "errors": [{ "path": "account.domain", "message": "Must be a domain like acme.com." }],
  "correlation_id": "cor_01JB..."
}
```

Error types: `validation`, `unauthenticated`, `key-revoked`, `forbidden` (with `missing_scope`),
`not-found`, `conflict`, `idempotency-mismatch`, `rate-limited`, `cap-reached` (with `resets_at`),
`integration-unavailable`, `internal`.

**Rate limits.** Per key or grant: requests per minute (default 600) with headers `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset`; 429 with `Retry-After`. Arrival caps per day come from the
key's daily arrival cap through INT; over cap returns `cap-reached`.

**Correlation.** Every response carries `X-Correlation-Id`; callers may send their own
(`X-Correlation-Id: <up to 64 chars>`), which is then used for every event the request causes.

**Times and money.** RFC 3339 UTC timestamps; money as `{ "amount_cents": 4800000, "currency": "USD" }`;
rates as decimals.

## Stories

### API-E1-S1 Consistent errors
As an agent builder, I want every error in one shape with the field path, so that my agent can fix
its own requests.
- API-E1-S1-AC1 A request with two invalid fields returns 400 with both in `errors[]`.
- API-E1-S1-AC2 Every error includes `correlation_id` matching the response header.

### API-E1-S2 Safe retries
As an agent builder, I want to retry a timed-out request without creating duplicates, so that network
failures are harmless.
- API-E1-S2-AC1 Two `POST /arrivals` with the same `Idempotency-Key` and body create one arrival and
  return the same `arrival_id`.
- API-E1-S2-AC2 Same `external_ref` from the same source without an idempotency key returns the first
  arrival with status 200 and `"duplicate_of_request": true`.

### API-E1-S3 Data limits are invisible walls
As an owner, I want agents to see only their own submissions, so that partners can't browse our
pipeline.
- API-E1-S3-AC1 A key with `own_source` gets 404 for an account its source never sent, and list
  endpoints never include such accounts.

### API-E1-S4 Rate limiting
- API-E1-S4-AC1 The 601st request in a minute returns 429 with `Retry-After`.
- API-E1-S4-AC2 Rate limit counters are shared across web instances (Postgres or NATS KV backed).
