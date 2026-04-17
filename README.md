# Wallet Ledger API

A REST API that does wallet-style accounting the right way: append-only ledger entries, integer-cents money math, idempotent transfers, and a working playground UI.

Built on Cloudflare Workers + KV with Hono, Zod, and no database. Every balance is derived by summing the ledger — balances are never stored. Transfers use the two-phase idempotent retry pattern (body-hash scoped, 24h TTL) so network retries are safe without double-spending.

## Live Demo

<https://wallet-ledger-api.oliver-leonor.workers.dev/ui>

## Features

- **Append-only ledger** — Every financial event becomes an immutable `LedgerEntry`. Balances are derived, not stored. Auditable by design.
- **Integer cents everywhere** — No floats in the money path. The UI converts display values (`120.00`) to `amountCents` (`12000`) before sending.
- **Idempotent transfers** — Clients send an `Idempotency-Key` header. Retries with the same key and same body replay the original response. Retries with the same key and different body return `422 IDEMPOTENCY_KEY_REUSED` (Stripe-style).
- **Bearer token auth on writes** — The UI fetches a shared demo token. Reads are public so the playground and embedded previews work without a login.
- **Request correlation** — Every response includes an `x-request-id` header and errors echo the ID so bug reports are traceable end-to-end.
- **Structured error responses** — Consistent shape across all failure modes: `{ error: { code, message, requestId } }`.
- **Paginated ledger reads** — `GET /accounts/:id/ledger?limit=100&cursor=...` returns a `hasMore` flag instead of silently truncating.
- **Real test suite** — 17 integration tests covering the full account lifecycle, auth, validation, transfer semantics, and idempotent-replay behavior.

## Tech Stack

| Layer | Technology | Why |
| --- | --- | --- |
| Runtime | Cloudflare Workers | Zero cold-start edge runtime, free tier, regional KV |
| Router | Hono | ~12kb, faster than Express, TypeScript-first |
| Validation | Zod | Parse-don't-validate at every boundary |
| Storage | Cloudflare KV (3 namespaces) | Eventually consistent, good fit for an append-only model |
| ID generation | nanoid | 12-char URL-safe IDs, collision-resistant |
| UI | Static HTML served via ASSETS binding | Zero build step, near-instant TTFB |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | Runs specs against the real workerd runtime, not a mock |
| Deployment | Wrangler | One-command deploys, auto KV + assets upload |

## Architecture

```
POST /accounts          → KV:ACCOUNTS       (one record per account)
POST /accounts/:id/deposit → KV:LEDGER      (append CREDIT entry)
POST /transfers         → KV:IDEMPOTENCY    (check key + body hash)
                        → KV:LEDGER         (append DEBIT + CREDIT)
                        → KV:IDEMPOTENCY    (store result with 24h TTL)
GET  /accounts/:id/balance → KV:LEDGER      (paginate + sum)
GET  /accounts/:id/ledger  → KV:LEDGER      (paginate with cursor)
```

Three separate KV namespaces so the access patterns don't fight:

- `ACCOUNTS` — one record per account, keyed `account:<id>`
- `LEDGER` — timestamp-prefixed keys (`ledger:<accountId>:<ts>:<entryId>`) so list-by-prefix returns chronologically sorted entries
- `IDEMPOTENCY` — transient, 24h TTL, keyed by `idem:transfer:<clientKey>`

See [DECISIONS.md](./DECISIONS.md) for why each piece is the way it is.

## Running Locally

```
git clone https://github.com/Oliver-Leonor/wallet-ledger-api.git
cd wallet-ledger-api
npm install
npx wrangler secret put DEMO_API_TOKEN    # set any string
npm run dev
```

Open <http://localhost:8787/ui> to play with the UI.

## Running Tests

```
npm test
```

Runs the full suite against the real workerd runtime via Miniflare. Tests use isolated in-memory KV namespaces so they can't touch production data.

## Deploying

Requires a Cloudflare account with Workers + KV enabled.

```
# First-time setup: create three KV namespaces and paste the IDs into wrangler.jsonc
npx wrangler kv namespace create ACCOUNTS
npx wrangler kv namespace create LEDGER
npx wrangler kv namespace create IDEMPOTENCY

# Set the shared demo token (one-time)
npx wrangler secret put DEMO_API_TOKEN

# Deploy
npm run deploy
```

## API Reference

### `GET /`

Returns the list of routes and a link to the source.

### `GET /health`

Liveness check. Returns `{ "ok": true }`.

### `GET /demo-token`

Returns the current shared demo bearer token so the UI can auto-populate it. The token is deliberately public — its purpose is to stop scraping, not to provide real per-user auth.

### `POST /accounts` *(requires bearer token)*

Create a new account.

```json
{ "currency": "PHP" }
```

Returns the created `Account` with `201`.

### `POST /accounts/:id/deposit` *(requires bearer token)*

Credit funds to an account.

```json
{ "amountCents": 50000 }
```

Appends a `CREDIT` ledger entry. Returns `{ depositId, accountId, balanceCents }` with `201`.

### `POST /transfers` *(requires bearer token + `Idempotency-Key` header)*

Move funds between two accounts with the same currency.

```json
{ "fromAccountId": "...", "toAccountId": "...", "amountCents": 1500 }
```

Appends a `DEBIT` entry on the source and a matching `CREDIT` on the destination. Requires:

- `Authorization: Bearer <token>`
- `Idempotency-Key: <4-128 chars>`

Returns `{ transferId, fromBalanceCents, ... }` with `201`. Retries with the same key and body replay the original response with `idempotentReplay: true` added. Retries with the same key and a different body return `422 IDEMPOTENCY_KEY_REUSED`.

### `GET /accounts/:id/balance`

Returns `{ accountId, currency, balanceCents }` by summing the ledger.

### `GET /accounts/:id/ledger?limit=100&cursor=...`

Returns `{ entries, nextCursor, hasMore }`. Default `limit` is 100, max 500. Paginate by passing `cursor=<nextCursor>` from the previous response.

## Error Response Shape

All failures return:

```json
{
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Insufficient funds",
    "requestId": "2d9a...c0b7"
  }
}
```

Common codes:

| Code | Status | When |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Missing or wrong bearer token on a write |
| `VALIDATION` | 400 | Body fails Zod schema |
| `NOT_FOUND` | 404 | Account doesn't exist |
| `MISSING_IDEMPOTENCY_KEY` | 400 | Transfer sent without `Idempotency-Key` |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different body |
| `INVALID_TRANSFER` | 400 | from == to |
| `CURRENCY_MISMATCH` | 400 | Cross-currency transfer |
| `INSUFFICIENT_FUNDS` | 409 | Source balance < amount |
| `INTERNAL_ERROR` | 500 | Unhandled exception (logged with request ID) |

## Key Architecture Decisions

See [DECISIONS.md](./DECISIONS.md) for rationale on every technical choice — what I picked, what I considered, and what I'm accepting as a limitation.

## Author

**Oliver Leonor** — Full-Stack Developer & AI Engineer

- Portfolio: [oliver-leonor.vercel.app](https://oliver-leonor.vercel.app)
- GitHub: [github.com/Oliver-Leonor](https://github.com/Oliver-Leonor)
- LinkedIn: [linkedin.com/in/oliver-leonor-582706228](https://linkedin.com/in/oliver-leonor-582706228)
