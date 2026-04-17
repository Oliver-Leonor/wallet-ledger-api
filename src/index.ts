import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';

// =============================================================================
// Types & bindings
// =============================================================================

type Bindings = {
	ACCOUNTS: KVNamespace;
	LEDGER: KVNamespace;
	IDEMPOTENCY: KVNamespace;
	ASSETS: Fetcher;

	/**
	 * Shared demo token for write operations. Set via:
	 *   wrangler secret put DEMO_API_TOKEN
	 * The token is static and public-facing (it's meant to be copied from the UI),
	 * but requiring it means scraping bots and accidental scripts can't mutate the
	 * demo. For anything beyond a demo, replace this with per-user auth.
	 */
	DEMO_API_TOKEN: string;
};

type Account = {
	id: string;
	currency: string;
	createdAt: string;
};

type LedgerEntry = {
	id: string;
	accountId: string;
	type: 'DEPOSIT' | 'TRANSFER';
	direction: 'CREDIT' | 'DEBIT';
	amountCents: number;
	currency: string;
	referenceId: string;
	createdAt: string;
};

type IdempotentRecord = {
	bodyHash: string;
	response: unknown;
	statusCode: number;
	createdAt: string;
};

type Vars = { requestId: string };

const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();

// =============================================================================
// Constants
// =============================================================================

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const LEDGER_PAGE_SIZE = 100;
const LEDGER_MAX_PAGE_SIZE = 500;

// =============================================================================
// Helpers
// =============================================================================

const accountKey = (id: string) => `account:${id}`;
const ledgerPrefix = (accountId: string) => `ledger:${accountId}:`;
const ledgerKey = (accountId: string, ts: number, entryId: string) =>
	`ledger:${accountId}:${String(ts).padStart(13, '0')}:${entryId}`;

async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
	const bytes = new Uint8Array(hash);
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

async function getAccount(env: Bindings, id: string): Promise<Account | null> {
	const a = await env.ACCOUNTS.get(accountKey(id), { type: 'json' });
	return (a as Account) ?? null;
}

async function listLedger(
	env: Bindings,
	accountId: string,
	limit: number,
	cursor?: string
): Promise<{ entries: LedgerEntry[]; nextCursor: string | null; hasMore: boolean }> {
	const clampedLimit = Math.min(Math.max(limit, 1), LEDGER_MAX_PAGE_SIZE);
	const listed = await env.LEDGER.list({
		prefix: ledgerPrefix(accountId),
		limit: clampedLimit,
		cursor,
	});

	const entries: LedgerEntry[] = [];
	for (const k of listed.keys) {
		const e = await env.LEDGER.get(k.name, { type: 'json' });
		if (e) entries.push(e as LedgerEntry);
	}
	entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

	return {
		entries,
		nextCursor: listed.list_complete ? null : listed.cursor ?? null,
		hasMore: !listed.list_complete,
	};
}

/**
 * Full balance sweep. Uses repeated paginated reads so we don't silently
 * truncate at 500 entries like the original did.
 */
async function getBalanceCents(env: Bindings, accountId: string): Promise<number> {
	let cursor: string | undefined;
	let bal = 0;
	// Cap the sweep at a sane upper bound so a pathologically large account
	// can't hang a request. Real production would materialize a balance snapshot.
	const MAX_SWEEPS = 20;
	for (let i = 0; i < MAX_SWEEPS; i++) {
		const page = await listLedger(env, accountId, LEDGER_MAX_PAGE_SIZE, cursor);
		for (const e of page.entries) {
			bal += e.direction === 'CREDIT' ? e.amountCents : -e.amountCents;
		}
		if (!page.nextCursor) return bal;
		cursor = page.nextCursor;
	}
	return bal;
}

// =============================================================================
// Schemas
// =============================================================================

const CreateAccountSchema = z.object({
	currency: z.string().min(3).max(10).default('PHP'),
});

const AmountSchema = z.object({
	amountCents: z.number().int().positive().max(1_000_000_000), // cap at $10M to prevent overflow games
});

const TransferSchema = z.object({
	fromAccountId: z.string().min(4).max(32),
	toAccountId: z.string().min(4).max(32),
	amountCents: z.number().int().positive().max(1_000_000_000),
});

// =============================================================================
// Middleware
// =============================================================================

/**
 * Request correlation. Every response gets an x-request-id header so errors
 * are traceable end to end.
 */
app.use('*', async (c, next) => {
	const requestId = globalThis.crypto.randomUUID();
	c.set('requestId', requestId);
	c.header('x-request-id', requestId);
	await next();
});

/**
 * CORS — permissive for the demo since the UI is served from the same origin,
 * but browsers sending from other origins (curl, portfolio iframe, etc.) also
 * get to hit the API without pre-flight pain.
 */
app.use('*', async (c, next) => {
	c.header('Access-Control-Allow-Origin', '*');
	c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	c.header(
		'Access-Control-Allow-Headers',
		'Content-Type, Authorization, Idempotency-Key'
	);
	c.header('Access-Control-Expose-Headers', 'x-request-id');
	if (c.req.method === 'OPTIONS') return c.body(null, 204);
	await next();
});

/**
 * Bearer auth gate for write routes. Reads exist without auth so the portfolio
 * preview can display balances without the user typing a token. Writes require
 * the shared demo token.
 */
function requireDemoToken(c: {
	env: Bindings;
	req: { header: (name: string) => string | undefined };
	json: (body: unknown, status: number) => Response;
	get: (key: 'requestId') => string;
}) {
	const expected = c.env.DEMO_API_TOKEN;
	if (!expected) {
		// Fail closed if the secret isn't configured. This means the deploy is
		// broken; log it so it's obvious in Cloudflare's tail.
		console.error('[auth] DEMO_API_TOKEN not configured');
		return c.json(
			{
				error: {
					code: 'AUTH_NOT_CONFIGURED',
					message: 'Server auth is not configured. Contact the demo operator.',
					requestId: c.get('requestId'),
				},
			},
			500
		);
	}

	const header = c.req.header('Authorization') ?? '';
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	const presented = match?.[1];

	if (!presented || presented !== expected) {
		return c.json(
			{
				error: {
					code: 'UNAUTHORIZED',
					message:
						'Bearer token required. Copy the demo token from /ui and send as Authorization: Bearer <token>.',
					requestId: c.get('requestId'),
				},
			},
			401
		);
	}
	return null;
}

/**
 * Public-facing token endpoint. The UI fetches this to populate the copy-paste
 * box. Because the token is shared and public it's safe to serve, but gating
 * mutations behind it still stops bots and drive-by mutations.
 */
app.get('/demo-token', (c) => {
	// Never cache this response at the edge. Our auth state can flip between
	// 500 (unconfigured) and 200 (configured) when a secret is set without a
	// redeploy, and a cached 500 would lock the UI out for minutes.
	c.header('Cache-Control', 'no-store');
	if (!c.env.DEMO_API_TOKEN) {
		return c.json({ error: { code: 'AUTH_NOT_CONFIGURED' } }, 500);
	}
	return c.json({ token: c.env.DEMO_API_TOKEN });
});

// =============================================================================
// Error handler
// =============================================================================

app.onError((err, c) => {
	const requestId = c.get('requestId') ?? 'unknown';
	// Log with context so Cloudflare Workers Logs actually show something.
	console.error('[error]', {
		requestId,
		path: c.req.path,
		method: c.req.method,
		message: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	});
	return c.json(
		{
			error: {
				code: 'INTERNAL_ERROR',
				message: 'Unexpected server error. Include requestId when reporting.',
				requestId,
			},
		},
		500
	);
});

// =============================================================================
// Meta routes
// =============================================================================

app.get('/', (c) =>
	c.json({
		name: 'wallet-ledger-api',
		version: '1.0.0',
		routes: [
			'GET /health',
			'GET /demo-token',
			'POST /accounts (auth)',
			'POST /accounts/:id/deposit (auth)',
			'POST /transfers (auth, idempotent)',
			'GET /accounts/:id/balance',
			'GET /accounts/:id/ledger',
			'GET /ui',
		],
		docs: 'https://github.com/Oliver-Leonor/wallet-ledger-api',
	})
);

app.get('/health', (c) => c.json({ ok: true }));

/**
 * UI is served as a static asset. The HTML lives at `public/index.html`
 * and Cloudflare's assets binding serves it at `/ui`.
 */
app.get('/ui', async (c) => {
	const res = await c.env.ASSETS.fetch(new URL('/index.html', c.req.url).toString());
	// Re-wrap so we can pin content-type and cache headers explicitly.
	return new Response(res.body, {
		status: res.status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'public, max-age=60',
		},
	});
});

// =============================================================================
// Write routes (require bearer token)
// =============================================================================

app.post('/accounts', async (c) => {
	const authError = requireDemoToken(c);
	if (authError) return authError;

	const body = CreateAccountSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!body.success) {
		return c.json({ error: { code: 'VALIDATION', issues: body.error.issues } }, 400);
	}

	const id = nanoid(12);
	const account: Account = {
		id,
		currency: body.data.currency,
		createdAt: new Date().toISOString(),
	};

	await c.env.ACCOUNTS.put(accountKey(id), JSON.stringify(account));
	return c.json({ account }, 201);
});

app.post('/accounts/:id/deposit', async (c) => {
	const authError = requireDemoToken(c);
	if (authError) return authError;

	const id = c.req.param('id');
	const acc = await getAccount(c.env, id);
	if (!acc) {
		return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);
	}

	const body = AmountSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!body.success) {
		return c.json({ error: { code: 'VALIDATION', issues: body.error.issues } }, 400);
	}

	const depositId = nanoid(12);
	const now = new Date();
	const entry: LedgerEntry = {
		id: nanoid(12),
		accountId: id,
		type: 'DEPOSIT',
		direction: 'CREDIT',
		amountCents: body.data.amountCents,
		currency: acc.currency,
		referenceId: depositId,
		createdAt: now.toISOString(),
	};

	await c.env.LEDGER.put(ledgerKey(id, now.getTime(), entry.id), JSON.stringify(entry));
	const balanceCents = await getBalanceCents(c.env, id);

	return c.json({ depositId, accountId: id, balanceCents }, 201);
});

app.post('/transfers', async (c) => {
	const authError = requireDemoToken(c);
	if (authError) return authError;

	const idemKey = c.req.header('Idempotency-Key');
	if (!idemKey || idemKey.length < 4 || idemKey.length > 128) {
		return c.json(
			{
				error: {
					code: 'MISSING_IDEMPOTENCY_KEY',
					message: 'Idempotency-Key header required (4-128 chars).',
					requestId: c.get('requestId'),
				},
			},
			400
		);
	}

	// Read body once, use for both schema parsing and body-hash lookup.
	const rawBodyText = await c.req.text();
	const bodyHash = await sha256Hex(rawBodyText);

	const idemStoreKey = `idem:transfer:${idemKey}`;
	const existing = (await c.env.IDEMPOTENCY.get(idemStoreKey, {
		type: 'json',
	})) as IdempotentRecord | null;

	if (existing) {
		// Defensive: if the same key is reused with a different body, that's a
		// client bug, not an idempotent retry. Stripe returns 422 here.
		if (existing.bodyHash !== bodyHash) {
			return c.json(
				{
					error: {
						code: 'IDEMPOTENCY_KEY_REUSED',
						message:
							'Idempotency-Key was previously used with a different request body.',
						requestId: c.get('requestId'),
					},
				},
				422
			);
		}
		// Genuine retry → replay the stored response.
		return c.json({ idempotentReplay: true, ...(existing.response as object) }, existing.statusCode as 200);
	}

	let parsedBody: unknown;
	try {
		parsedBody = rawBodyText ? JSON.parse(rawBodyText) : {};
	} catch {
		return c.json(
			{ error: { code: 'VALIDATION', message: 'Body must be valid JSON.' } },
			400
		);
	}
	const body = TransferSchema.safeParse(parsedBody);
	if (!body.success) {
		return c.json({ error: { code: 'VALIDATION', issues: body.error.issues } }, 400);
	}

	const { fromAccountId, toAccountId, amountCents } = body.data;
	if (fromAccountId === toAccountId) {
		return c.json(
			{
				error: {
					code: 'INVALID_TRANSFER',
					message: 'fromAccountId and toAccountId must differ',
				},
			},
			400
		);
	}

	const [from, to] = await Promise.all([
		getAccount(c.env, fromAccountId),
		getAccount(c.env, toAccountId),
	]);
	if (!from || !to) {
		return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);
	}
	if (from.currency !== to.currency) {
		return c.json(
			{
				error: {
					code: 'CURRENCY_MISMATCH',
					message: 'Accounts must have same currency in this prototype',
				},
			},
			400
		);
	}

	const fromBal = await getBalanceCents(c.env, fromAccountId);
	if (fromBal < amountCents) {
		return c.json(
			{
				error: {
					code: 'INSUFFICIENT_FUNDS',
					message: 'Insufficient funds',
					requestId: c.get('requestId'),
				},
			},
			409
		);
	}

	const transferId = nanoid(12);
	const now = new Date();
	const ts = now.getTime();

	const debit: LedgerEntry = {
		id: nanoid(12),
		accountId: fromAccountId,
		type: 'TRANSFER',
		direction: 'DEBIT',
		amountCents,
		currency: from.currency,
		referenceId: transferId,
		createdAt: now.toISOString(),
	};

	const credit: LedgerEntry = {
		id: nanoid(12),
		accountId: toAccountId,
		type: 'TRANSFER',
		direction: 'CREDIT',
		amountCents,
		currency: to.currency,
		referenceId: transferId,
		createdAt: now.toISOString(),
	};

	// Write both legs. In KV these aren't atomic; for real money you'd use
	// Durable Objects (see DECISIONS.md).
	await Promise.all([
		c.env.LEDGER.put(ledgerKey(fromAccountId, ts, debit.id), JSON.stringify(debit)),
		c.env.LEDGER.put(ledgerKey(toAccountId, ts, credit.id), JSON.stringify(credit)),
	]);

	const response = {
		transferId,
		fromAccountId,
		toAccountId,
		amountCents,
		currency: from.currency,
		fromBalanceCents: fromBal - amountCents,
	};

	// Record idempotent result with a TTL so KV doesn't fill up.
	const idemRecord: IdempotentRecord = {
		bodyHash,
		response,
		statusCode: 201,
		createdAt: now.toISOString(),
	};
	await c.env.IDEMPOTENCY.put(idemStoreKey, JSON.stringify(idemRecord), {
		expirationTtl: IDEMPOTENCY_TTL_SECONDS,
	});

	return c.json(response, 201);
});

// =============================================================================
// Read routes (no auth — safe for portfolio preview)
// =============================================================================

app.get('/accounts/:id/balance', async (c) => {
	const id = c.req.param('id');
	const acc = await getAccount(c.env, id);
	if (!acc) {
		return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);
	}

	const balanceCents = await getBalanceCents(c.env, id);
	return c.json({ accountId: id, currency: acc.currency, balanceCents });
});

app.get('/accounts/:id/ledger', async (c) => {
	const id = c.req.param('id');
	const acc = await getAccount(c.env, id);
	if (!acc) {
		return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);
	}

	const limitParam = c.req.query('limit');
	const cursor = c.req.query('cursor') ?? undefined;
	const limit = limitParam ? Math.min(Number(limitParam) || LEDGER_PAGE_SIZE, LEDGER_MAX_PAGE_SIZE) : LEDGER_PAGE_SIZE;

	const page = await listLedger(c.env, id, limit, cursor);
	return c.json({
		accountId: id,
		entries: page.entries,
		nextCursor: page.nextCursor,
		hasMore: page.hasMore,
	});
});

export default app;
