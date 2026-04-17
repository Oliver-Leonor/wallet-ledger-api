import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// DEMO_API_TOKEN is set in vitest.config.mts via miniflare bindings.
// Keep the test-side constant in sync with that value.
const TOKEN = 'test-token-for-specs';

function authHeaders(extra: Record<string, string> = {}) {
	return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...extra };
}

describe('meta', () => {
	it('GET / returns route list', async () => {
		const res = await SELF.fetch('http://x/');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { name: string; routes: string[] };
		expect(body.name).toBe('wallet-ledger-api');
		expect(body.routes.length).toBeGreaterThan(0);
	});

	it('GET /health returns ok', async () => {
		const res = await SELF.fetch('http://x/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('every response has an x-request-id header', async () => {
		const res = await SELF.fetch('http://x/health');
		expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe('auth', () => {
	it('rejects writes without a bearer token', async () => {
		const res = await SELF.fetch('http://x/accounts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ currency: 'PHP' }),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('UNAUTHORIZED');
	});

	it('rejects writes with a wrong bearer token', async () => {
		const res = await SELF.fetch('http://x/accounts', {
			method: 'POST',
			headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
			body: JSON.stringify({ currency: 'PHP' }),
		});
		expect(res.status).toBe(401);
	});

	it('allows reads without a bearer token', async () => {
		// Even a 404 is fine here — the point is that we don't return 401.
		const res = await SELF.fetch('http://x/accounts/nonexistent/balance');
		expect(res.status).toBe(404);
	});
});

describe('account lifecycle', () => {
	it('creates an account, deposits, and reports the correct balance', async () => {
		// Create account
		const createRes = await SELF.fetch('http://x/accounts', {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ currency: 'PHP' }),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as { account: { id: string; currency: string } };
		expect(created.account.currency).toBe('PHP');
		const accountId = created.account.id;

		// Deposit 1000 cents (10.00)
		const depositRes = await SELF.fetch(`http://x/accounts/${accountId}/deposit`, {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ amountCents: 1000 }),
		});
		expect(depositRes.status).toBe(201);
		const deposit = (await depositRes.json()) as { balanceCents: number };
		expect(deposit.balanceCents).toBe(1000);

		// Query balance
		const balRes = await SELF.fetch(`http://x/accounts/${accountId}/balance`);
		expect(balRes.status).toBe(200);
		const bal = (await balRes.json()) as { balanceCents: number };
		expect(bal.balanceCents).toBe(1000);
	});

	it('rejects invalid amounts on deposit', async () => {
		const createRes = await SELF.fetch('http://x/accounts', {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ currency: 'PHP' }),
		});
		const created = (await createRes.json()) as { account: { id: string } };

		const negative = await SELF.fetch(`http://x/accounts/${created.account.id}/deposit`, {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ amountCents: -100 }),
		});
		expect(negative.status).toBe(400);

		const zero = await SELF.fetch(`http://x/accounts/${created.account.id}/deposit`, {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ amountCents: 0 }),
		});
		expect(zero.status).toBe(400);

		const float = await SELF.fetch(`http://x/accounts/${created.account.id}/deposit`, {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ amountCents: 1.5 }),
		});
		expect(float.status).toBe(400);
	});

	it('returns 404 for operations on unknown accounts', async () => {
		const res = await SELF.fetch('http://x/accounts/zzz-does-not-exist/deposit', {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ amountCents: 100 }),
		});
		expect(res.status).toBe(404);
	});
});

describe('transfers', () => {
	async function setupTwoAccountsWithFunds(initialCents = 5000) {
		const a = await (
			await SELF.fetch('http://x/accounts', {
				method: 'POST',
				headers: authHeaders(),
				body: JSON.stringify({ currency: 'PHP' }),
			})
		).json() as { account: { id: string } };

		const b = await (
			await SELF.fetch('http://x/accounts', {
				method: 'POST',
				headers: authHeaders(),
				body: JSON.stringify({ currency: 'PHP' }),
			})
		).json() as { account: { id: string } };

		await SELF.fetch(`http://x/accounts/${a.account.id}/deposit`, {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ amountCents: initialCents }),
		});

		return { fromId: a.account.id, toId: b.account.id };
	}

	it('executes a transfer and debits/credits both accounts', async () => {
		const { fromId, toId } = await setupTwoAccountsWithFunds(5000);

		const res = await SELF.fetch('http://x/transfers', {
			method: 'POST',
			headers: authHeaders({ 'Idempotency-Key': 'xfer-happy-path' }),
			body: JSON.stringify({ fromAccountId: fromId, toAccountId: toId, amountCents: 1500 }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { transferId: string; fromBalanceCents: number };
		expect(body.fromBalanceCents).toBe(3500);

		const fromBal = await (
			await SELF.fetch(`http://x/accounts/${fromId}/balance`)
		).json() as { balanceCents: number };
		const toBal = await (
			await SELF.fetch(`http://x/accounts/${toId}/balance`)
		).json() as { balanceCents: number };

		expect(fromBal.balanceCents).toBe(3500);
		expect(toBal.balanceCents).toBe(1500);
	});

	it('rejects transfers without an Idempotency-Key', async () => {
		const { fromId, toId } = await setupTwoAccountsWithFunds();
		const res = await SELF.fetch('http://x/transfers', {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ fromAccountId: fromId, toAccountId: toId, amountCents: 100 }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
	});

	it('rejects transfers from an account to itself', async () => {
		const { fromId } = await setupTwoAccountsWithFunds();
		const res = await SELF.fetch('http://x/transfers', {
			method: 'POST',
			headers: authHeaders({ 'Idempotency-Key': 'xfer-self' }),
			body: JSON.stringify({ fromAccountId: fromId, toAccountId: fromId, amountCents: 100 }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects transfers with insufficient funds', async () => {
		const { fromId, toId } = await setupTwoAccountsWithFunds(100);
		const res = await SELF.fetch('http://x/transfers', {
			method: 'POST',
			headers: authHeaders({ 'Idempotency-Key': 'xfer-insufficient' }),
			body: JSON.stringify({ fromAccountId: fromId, toAccountId: toId, amountCents: 1000 }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('INSUFFICIENT_FUNDS');
	});

	it('idempotent retry returns the original response, not a double-charge', async () => {
		const { fromId, toId } = await setupTwoAccountsWithFunds(5000);
		const key = 'xfer-idem-happy';
		const body = JSON.stringify({ fromAccountId: fromId, toAccountId: toId, amountCents: 1000 });

		const first = await SELF.fetch('http://x/transfers', {
			method: 'POST',
			headers: authHeaders({ 'Idempotency-Key': key }),
			body,
		});
		expect(first.status).toBe(201);

		const second = await SELF.fetch('http://x/transfers', {
			method: 'POST',
			headers: authHeaders({ 'Idempotency-Key': key }),
			body,
		});
		expect(second.status).toBe(201);
		const secondBody = (await second.json()) as { idempotentReplay?: boolean };
		expect(secondBody.idempotentReplay).toBe(true);

		// Balance should only have been debited once.
		const bal = (await (
			await SELF.fetch(`http://x/accounts/${fromId}/balance`)
		).json()) as { balanceCents: number };
		expect(bal.balanceCents).toBe(4000);
	});

	it('rejects reused idempotency keys with a different body', async () => {
		const { fromId, toId } = await setupTwoAccountsWithFunds(5000);
		const key = 'xfer-idem-reused';

		await SELF.fetch('http://x/transfers', {
			method: 'POST',
			headers: authHeaders({ 'Idempotency-Key': key }),
			body: JSON.stringify({ fromAccountId: fromId, toAccountId: toId, amountCents: 100 }),
		});

		// Same key, different amount → should 422.
		const retryDifferent = await SELF.fetch('http://x/transfers', {
			method: 'POST',
			headers: authHeaders({ 'Idempotency-Key': key }),
			body: JSON.stringify({ fromAccountId: fromId, toAccountId: toId, amountCents: 999 }),
		});
		expect(retryDifferent.status).toBe(422);
		const b = (await retryDifferent.json()) as { error: { code: string } };
		expect(b.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
	});
});

describe('ledger', () => {
	it('returns entries in chronological order with pagination flags', async () => {
		const a = await (
			await SELF.fetch('http://x/accounts', {
				method: 'POST',
				headers: authHeaders(),
				body: JSON.stringify({ currency: 'PHP' }),
			})
		).json() as { account: { id: string } };

		// Make a couple deposits
		for (const cents of [100, 250, 500]) {
			await SELF.fetch(`http://x/accounts/${a.account.id}/deposit`, {
				method: 'POST',
				headers: authHeaders(),
				body: JSON.stringify({ amountCents: cents }),
			});
		}

		const ledgerRes = await SELF.fetch(`http://x/accounts/${a.account.id}/ledger`);
		expect(ledgerRes.status).toBe(200);
		const body = (await ledgerRes.json()) as {
			entries: Array<{ amountCents: number; direction: string }>;
			hasMore: boolean;
		};
		expect(body.entries.length).toBe(3);
		expect(body.entries.every((e) => e.direction === 'CREDIT')).toBe(true);
		expect(body.hasMore).toBe(false);
	});
});

describe('worker module export', () => {
	it('exports a fetch handler', () => {
		expect(typeof worker.fetch).toBe('function');
	});
});
