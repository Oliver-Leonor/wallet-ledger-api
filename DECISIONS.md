# Architecture Decisions

This document explains the architectural decisions behind **Wallet Ledger API**, a wallet-style REST service I built to demonstrate the ledger pattern on a serverless edge runtime. For each decision: **what I chose**, **why**, **what I considered instead**, and **the limitations I'm accepting**.

---

## Runtime & Framework

### I chose Cloudflare Workers over Node/Express on a VPS

**What I chose.** Cloudflare Workers, V8 isolates at the edge, with Hono as the router. Everything runs in a single `src/index.ts` entry point, no build step.

**Why.** This project's purpose is to look exactly like a production API would on day one. Workers give me zero cold-starts, regional KV storage, automatic HTTPS, and deploys that complete in under 10 seconds. The free tier covers the entire demo indefinitely. No server to patch, no Docker image to maintain, no load balancer to configure.

The V8 isolate model is genuinely different from a Node server — every request gets its own isolated context, there's no shared mutable state in memory, and middleware is cheap because there's no startup cost per request. For an API that lives and dies by per-request latency, this is the right shape.

**What I considered.** Node + Express on Railway or Fly — familiar, more middleware ecosystem. Ruled out because (a) I'd be paying for an always-on server to serve ~0 requests most of the time, (b) cold-start latency on scale-to-zero platforms is worse than Workers' near-zero, and (c) I wanted the project to read as "edge-native" rather than "lift-and-shift Node."

Deno Deploy was close, but the Cloudflare ecosystem around Workers (KV, Durable Objects, R2, Queues) is richer and I already know it from daily work.

**Limitations.** The Workers runtime isn't a full Node environment. No `fs`, no native modules, no streaming SQL drivers. For this project that's fine — but it's a real constraint if the API ever needs to call a legacy npm package that assumes Node.

### I chose Hono over building routing by hand

**What I chose.** Hono 4.x as the HTTP router. Middleware for request ID, CORS, and error handling. Route handlers are small, purpose-built, and tested directly.

**Why.** Workers ships with raw `Request` / `Response` only. You *can* build routing from scratch — pattern-match the URL, parse the body, set headers — but you'd rebuild 80% of what Hono gives you for free. Hono is tiny (~12kb), TypeScript-native, runs on every edge platform, and has first-class support for parameter parsing, validation middleware, and error boundaries.

Crucially, Hono's middleware pattern is what lets me keep the auth check, request correlation, and error logging in separate composable functions instead of inline in every route handler.

**What I considered.** itty-router — smaller but less ergonomic for typed params. sunder — older and less maintained. Plain `Request` / `Response` — rewriting the router wheel. Ruled all three out because Hono's tradeoffs are better for this exact shape.

**Limitations.** Hono's request body parsing is flexible enough that I had to be careful not to double-read the stream in the transfers route (which reads the raw text for hashing and then parses it as JSON). A framework with stricter request body semantics would prevent that class of mistake at the API level.

---

## Storage

### I chose Cloudflare KV over D1 / Postgres / Durable Objects

**What I chose.** Three separate KV namespaces: `ACCOUNTS`, `LEDGER`, `IDEMPOTENCY`. No relational database. No Durable Objects.

**Why.** KV maps cleanly to the access patterns here:

- **Account records** are one key per account, written once, read on every deposit/transfer. Perfect fit for KV's read-through cache.
- **Ledger entries** are append-only and list-by-prefix. Keying them as `ledger:<accountId>:<timestamp>:<entryId>` means the KV `list` operation returns them in chronological order for free.
- **Idempotency records** have a natural TTL (24h). KV supports `expirationTtl` on every write, so the namespace self-cleans.

Running all of this on a single Postgres database would work, but you'd need migrations, connection pooling, and a new layer of latency. For a demo of the ledger pattern, KV keeps the code honest to the Workers platform.

**What I considered.**

- **Cloudflare D1** (SQLite on edge) — would give me real transactions, which is the strongest case against KV. Ruled out because D1 was still beta-adjacent when I started and because the demo doesn't need transactions once you commit to the "append-only" discipline.
- **Postgres on Neon** — would work, adds a connection pooler and schema migration story I don't need at this scope.
- **Durable Objects** — the *correct* answer for strong consistency. I discuss this in "Concurrency" below, but the short version is that DO would have doubled the complexity of the demo for marginal gain on the happy path.

**Limitations.** KV is eventually consistent across regions. A write in Singapore can take ~60 seconds to propagate to the US. For a real financial product this would be unacceptable; I mitigate it here by having every balance operation list from the same namespace the write hit (so reads-after-write on the same edge are typically consistent within milliseconds), and by documenting the constraint openly.

### I chose three KV namespaces over one

**What I chose.** `ACCOUNTS`, `LEDGER`, `IDEMPOTENCY` are physically separate KV namespaces with independent quotas and TTL policies.

**Why.** Different access shapes, different lifecycles, different blast radius. If the idempotency namespace fills up with stale keys, it doesn't evict active account records. If a bug in transfer logic corrupts the ledger, idempotency records aren't touched.

It also makes the code self-documenting — any line that reads `env.LEDGER.put(...)` is clearly a ledger write, not ambiguously "some KV write."

**Limitations.** Three namespaces means three sets of IDs to keep in `wrangler.jsonc`. Slightly more bookkeeping at setup time. Worth it.

---

## Money Math

### I chose integer cents over decimal / string / BigInt

**What I chose.** All money values are `number` (JavaScript's double-precision float) but constrained to be integers representing cents. The UI multiplies user input by 100 before sending; the API validates with `z.number().int().positive()`.

**Why.** The classic mistake is storing money as `1.2` and later discovering `0.1 + 0.2 === 0.30000000000000004`. Storing cents as integers sidesteps the entire floating-point representation problem. JavaScript integers are safe up to `2^53 - 1`, which is ~$90 trillion in cents — comfortably more than any realistic wallet balance.

I cap individual amounts at $10M (`1_000_000_000` cents) in the Zod schema to keep things well within safe integer territory even with accumulated rollups, and to prevent overflow-style attack vectors.

**What I considered.**

- **BigInt** — overkill for the cap range I care about, and BigInt doesn't serialize to JSON natively (you need custom `toJSON`), which is friction I don't need.
- **Decimal library** (decimal.js, big.js) — adds a dependency for precision I don't need if I stick to integers.
- **Strings** — some financial systems store `"1.20"` as a string. Precise, but every operation requires parsing, and you lose Zod's native number validation.

**Limitations.** Sub-cent precision is impossible. If the service ever needed to handle fractional cents (FX fees, interest accrual), the schema would need to change.

---

## Idempotency

### I chose body-hash idempotency with a 24h TTL over simple key-only replay

**What I chose.** On every transfer, the server:

1. Checks for an existing record keyed by `Idempotency-Key` header
2. If it exists, compares the stored `bodyHash` (SHA-256) with the current request's body hash
3. If the hashes match → replay the original response with `idempotentReplay: true`
4. If the hashes differ → return `422 IDEMPOTENCY_KEY_REUSED`
5. If no record exists → execute the transfer, then persist `{ bodyHash, response, statusCode }` with a 24-hour TTL

**Why.** This is how Stripe does it, and they got it right for a reason. The three failure modes this protects against:

- **Retry after network failure** — the original record is returned, no double-charge.
- **Client bug reusing a key with a different payload** — instead of silently returning a stale response for a different transaction, the server fails loudly with a 422 so the bug is visible.
- **KV fills up with forever-records** — the TTL bounds storage growth.

The body hash is the non-negotiable part. Without it, a client that reuses `idem-key-42` for two genuinely different transfers would get the first response back on the second call, which is silently wrong in a way that would take forever to debug.

**What I considered.**

- **Key-only replay** (what the original code did) — simpler, but fails the "reused key" case.
- **No TTL** — simpler, but KV would fill up indefinitely.
- **Storing full request + response instead of just a hash** — more storage, same correctness. Hash is enough.

**Limitations.** Idempotency is not atomicity. Two concurrent requests with the same fresh key can both pass the "does record exist" check, both execute the transfer, and both try to write their result to KV. The last writer wins, but both debits land on the ledger. In KV this is a theoretical concern — the window is tens of milliseconds — but it's real. The correct fix is Durable Objects with serialized access per account, discussed below.

### I chose to fail loudly on reused keys with different bodies

**What I chose.** Returning `422 IDEMPOTENCY_KEY_REUSED` when the same key is paired with a different request body.

**Why.** This is the hidden sharp edge of naive idempotency. If a client reuses a key by mistake (bug in their retry logic, a UUID collision, whatever) and sends a new transfer, the naive pattern returns the *old* response. The client sees "transfer succeeded" for the new amount but the ledger was never debited for it. Money goes missing.

Failing loudly turns a silent money leak into a visible 422, which the client code will catch in testing long before production.

**Limitations.** A legitimate client writing the SDK correctly will never hit this. Adding the hash check is pure insurance.

---

## Concurrency

### I chose to document the race condition rather than fix it

**What I chose.** The transfer path does `getBalanceCents()` → check against `amountCents` → `LEDGER.put()` without a lock. I added the body-hash idempotency, input caps, and test coverage, but I did not move to Durable Objects for serialized per-account access.

**Why.** This is the single most defensible tradeoff in the project, and the one I'd own in an interview. Moving to Durable Objects is the correct fix — one DO per account would serialize access, enable true atomicity on the balance check + write, and eliminate the race. But DO is a substantial architectural change: the ledger lives inside the DO, reads go through the DO's `fetch` interface, and the cost model changes (DO requests are charged separately). For a demo whose purpose is to *show the pattern*, doubling the code complexity to close a window that's ~50ms wide in practice buys very little.

Instead I made the tradeoff explicit: idempotency keys give safe retries, balance checks read from the same namespace, amounts are capped to prevent overflow games, and this document calls out exactly what would change in a production migration.

**What I considered.**

- **Durable Object per account** — correct, doable in a weekend. Didn't do it because the demo should show the KV pattern, not the DO pattern.
- **Optimistic concurrency** (stamp each account with a version, CAS on write) — KV doesn't natively support CAS.
- **Global lock** via a single DO — serializes *all* transfers globally, terrible throughput.

**Limitations.** Two concurrent transfers from the same account with enough funds to cover either individually but not both can both succeed, creating an overdraft. The ledger is still append-only and the overdraft is reconcilable after the fact, which is the weak "eventual correctness" story for this tier. Acceptable for a demo, unacceptable for production.

---

## Auth

### I chose a shared bearer token on writes, public reads

**What I chose.** All write endpoints (create account, deposit, transfer) require `Authorization: Bearer <token>`. Reads (balance, ledger, health) are open. The token is fetched from a `GET /demo-token` endpoint that the UI calls on boot.

**Why.** Three constraints pulled against each other:

1. Anyone who visits the portfolio should see the UI working end-to-end.
2. Random bots and scrapers shouldn't be able to spam `POST /accounts` and fill up KV.
3. The demo shouldn't require the visitor to sign up for anything.

A shared demo token hits all three. The UI fetches it on load and attaches it automatically; curl/Postman users copy it from the UI card and paste it into their headers. It's public, but possession of it is the bar that stops drive-by mutations.

**What I considered.**

- **No auth** — what the original code did. Invites abuse.
- **Rate limiting only** (Cloudflare's WAF or a custom bucket in KV) — useful but orthogonal; doesn't actually stop determined misuse, just slows it.
- **Full per-user auth** — would require a sign-up flow, user table, session tokens, all of which is a different project. Out of scope.

**Limitations.** The shared token doesn't scope access — every user mutates the same KV namespaces. In a real product, account records would have owner IDs and every mutation would check ownership. I explicitly don't do that here; see the `README.md` API reference for honesty about this.

### I chose to fail closed if the token secret is missing

**What I chose.** If `DEMO_API_TOKEN` is unset on the deploy, write routes return `500 AUTH_NOT_CONFIGURED` instead of allowing unauthenticated writes.

**Why.** Fail-closed is the only correct default for auth middleware. A deploy that forgot to set the secret should be noisily broken, not silently wide open.

**Limitations.** An operator who deploys without running `wrangler secret put DEMO_API_TOKEN` will see every write fail with 500 until they fix it. That's the correct outcome.

---

## Validation

### I chose Zod schemas at every boundary

**What I chose.** Every write route parses its request body through a Zod schema. Zod failures return `400 VALIDATION` with the full `issues` array so the client knows exactly which field is wrong.

**Why.** Two reasons. First, TypeScript types are compile-time only — the server has no idea what the client sent until it parses it at runtime. Zod is the gateway. Second, Zod schemas are self-documenting and give a single source of truth: the same schema can be reused in tests to generate valid/invalid inputs.

Important detail: Zod's `z.number().int().positive()` catches negative amounts, zero, and floats in one declaration. No hand-rolled `if (amount <= 0 || !Number.isInteger(amount))` scattered across handlers.

**What I considered.** Manual validation with `typeof` checks — verbose, inconsistent, easy to forget a case. Valibot — newer, smaller, but Zod's ecosystem and error reporting are better.

**Limitations.** Zod is ~20kb minified, which on Workers adds a small amount to cold start (not zero, but the isolates reuse across requests in practice). I considered stripping to a hand-rolled validator for every bytes saved; Zod earns its weight in clarity.

---

## UI

### I chose static HTML served via the ASSETS binding over an inline template

**What I chose.** The playground UI lives at `public/index.html` as a single self-contained file (inline CSS, inline JavaScript, loaded IBM Plex fonts from Google Fonts). Cloudflare's static assets binding serves it; the `/ui` route in the Worker proxies it so I can pin cache headers.

**Why.** The original code embedded the entire UI as a template literal inside the Worker source (286 lines of HTML/CSS/JS in a backtick string). That's unreadable, loses syntax highlighting, breaks on any apostrophe, and couples a frontend change to a Worker redeploy.

Moving to a static file means: real HTML tooling (prettier, Biome), syntax highlighting, the Worker source stays about the API, and edits to the UI can technically ship without a Worker rebuild.

**What I considered.** A full React build (Vite → Worker) — overkill for a single interactive page. A separate Pages deploy — extra deploy target, extra domain, no reason to split.

**Limitations.** Static HTML means no component reuse, no framework ergonomics. The file is 700-ish lines of vanilla JS and CSS. Fine at this size; would not scale to a multi-screen app.

### I chose a custom style matched to my portfolio over a UI framework

**What I chose.** Hand-rolled CSS using the same design tokens as my portfolio (charcoal `#161617` background, sage `#7fb069` accent, IBM Plex Mono for labels, IBM Plex Sans for copy).

**Why.** This UI is linked from my portfolio. If a hiring manager clicks through from the portfolio and lands on a page with Bootstrap defaults or shadcn primitives, it looks like a detached side project. Matching the palette makes the two projects read as one body of work.

**Limitations.** No dark/light toggle — the UI is dark-only. Adding a toggle is ~30 lines of CSS variables + a button; didn't bother because the design token sets are from my portfolio which runs dark by default anyway.

---

## Testing

### I chose `@cloudflare/vitest-pool-workers` over standalone Vitest

**What I chose.** Tests run inside the real `workerd` runtime via Cloudflare's official Vitest pool. `SELF.fetch('http://x/...')` sends a request to the actual Worker under test. KV bindings are backed by Miniflare's in-memory implementation so tests don't touch production data.

**Why.** The alternative is mocking. Every mock is a chance for your test suite to diverge from reality — you end up testing your mocks instead of your code. Running against `workerd` means the test sees the same request lifecycle, the same response handling, and the same KV semantics as production.

The Miniflare KV implementation is particularly valuable: it respects TTL, it supports `list` with prefixes, and it resets between test files so tests are independent.

**What I considered.**

- **Mocked `Request`/`Response`** with Vitest alone — lighter, but you're testing fiction.
- **Integration tests against a staging Worker** — real, but slow and requires secrets to be set in CI.

**Limitations.** `workerd` in tests runs on a slightly older compatibility date than the `compatibility_date: "2026-01-03"` in `wrangler.jsonc`. Vitest warns about this at boot; harmless but worth knowing.

---

## Observability

### I chose structured console logs keyed by request ID

**What I chose.** Every response carries an `x-request-id` header (generated as a UUID per request). The error handler logs `{ requestId, path, method, message, stack }` to `console.error`, which Cloudflare Workers Logs captures.

**Why.** The original code returned `requestId` in error responses but never actually logged anything, which made it a nice-looking string the client could include in a bug report but not actually useful for debugging. Now the flow is: client reports "I saw requestId `2d9a...c0b7` and got a 500", you search Workers Logs for that string, and the full error context comes back in one hit.

**What I considered.** Structured JSON logs to an external service (Axiom, Datadog). Useful at scale, overkill here.

**Limitations.** Workers Logs have a retention limit. For long-term forensics you'd pipe logs out via a Logpush job.

---

## Tradeoffs & Limitations

A consolidated list of things I know I'm accepting:

- **No real concurrency control.** Two simultaneous transfers from the same account can both pass the balance check. Fix: Durable Object per account (documented above).
- **Shared auth token, not per-user.** Anyone with the token can mutate anything. Fix: user table + session tokens + per-record ownership.
- **KV is eventually consistent.** Cross-region reads can see stale data for up to ~60s. Fix: move authoritative reads to Durable Objects.
- **Ledger balance sweep is O(n) per read.** An account with 10,000 entries does 100+ paginated KV reads per balance call. Fix: maintain a rolling balance snapshot in `ACCOUNTS` and reconcile asynchronously.
- **No transaction log compaction.** The ledger grows without bound. Fix: snapshot-and-truncate past a retention horizon.
- **No webhooks / no event stream.** Clients have to poll. Fix: Cloudflare Queues or Durable Object WebSocket fan-out.
- **No FX / multi-currency settlement.** Transfers between differing currencies return 400. Fix: FX rate oracle + settlement currency.
- **UI reads tokens from `/demo-token` over plain HTTPS.** Fine for a public shared token, not fine for anything real.
- **No rate limiting beyond Cloudflare's default.** A determined abuser with the token can still hammer KV. Fix: `@upstash/ratelimit` or a custom KV-backed token bucket.
- **Tests emit a harmless `jsg.TypeError: Can't read from request stream` warning.** It surfaces when the static-assets middleware consumes the request body for a path-match check that never applies. Cosmetic; 17/17 tests still pass.
