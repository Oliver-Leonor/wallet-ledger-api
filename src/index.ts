import { Hono } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';

type Bindings = {
	ACCOUNTS: KVNamespace;
	LEDGER: KVNamespace;
	IDEMPOTENCY: KVNamespace;
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

type Vars = { requestId: string };

const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();

/**
 * JD mapping:
 * - "Write clean, secure, maintainable code": central helpers + consistent errors
 * - "Troubleshoot and resolve backend issues": requestId + structured error responses
 */
app.onError((err, c) => {
	const requestId = c.get('requestId') ?? 'unknown';
	return c.json(
		{
			error: {
				code: 'INTERNAL_ERROR',
				message: 'Unexpected server error',
				requestId,
			},
		},
		500
	);
});

app.use('*', async (c, next) => {
	// lightweight request correlation (observability)
	const requestId = globalThis.crypto.randomUUID();
	c.set('requestId', requestId);
	c.header('x-request-id', requestId);
	await next();
});

app.get('/', (c) =>
	c.json({
		name: 'wallet-ledger-api',
		routes: [
			'GET /health',
			'POST /accounts',
			'POST /accounts/:id/deposit',
			'POST /transfers',
			'GET /accounts/:id/balance',
			'GET /accounts/:id/ledger',
		],
	})
);

app.get('/health', (c) => {
	// JD mapping: "Monitor system health"
	return c.json({ ok: true });
});

app.get('/ui', (c) => {
	return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>wallet-ledger-api UI</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }
    h1 { margin: 0 0 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 14px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    label { font-size: 12px; color: #444; display: block; margin-bottom: 6px; }
    input, select, button { padding: 8px 10px; border: 1px solid #ccc; border-radius: 8px; }
    button { cursor: pointer; }
    button.primary { border-color: #111; background: #111; color: #fff; }
    code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
    pre { background: #0b1020; color: #e7e7e7; padding: 12px; border-radius: 10px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #eee; padding: 8px; font-size: 12px; text-align: left; }
    .muted { color: #666; font-size: 12px; }
    .pill { display: inline-block; padding: 2px 8px; border: 1px solid #ddd; border-radius: 999px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Wallet + Ledger UI</h1>
  <div class="muted">
    Open endpoints at <code>/</code> (routes JSON) • Health at <code>/health</code> • This UI at <code>/ui</code>
  </div>

  <div class="grid" style="margin-top:16px;">
    <div class="card">
      <h2 style="margin:0 0 10px;">1) Accounts</h2>
      <div class="row">
        <div>
          <label>Currency</label>
          <select id="currency">
            <option value="PHP">PHP</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div style="align-self:end;">
          <button class="primary" id="btnCreate">Create account</button>
        </div>
      </div>
      <div style="margin-top:10px;" class="muted">Saved locally for this UI (localStorage).</div>
      <div id="accountsList" style="margin-top:12px;"></div>

      <div style="margin-top:12px;" class="row">
        <button id="btnRefresh" class="primary">Refresh balances</button>
        <button id="btnReset">Reset UI (local)</button>
      </div>
      <div id="balances" style="margin-top:10px;"></div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 10px;">2) Deposit</h2>
      <div class="row">
        <div style="min-width:240px;">
          <label>Account</label>
          <select id="depositAccount"></select>
        </div>
        <div>
          <label>Amount (PHP)</label>
          <input id="depositAmount" type="number" step="0.01" placeholder="e.g. 500.00" />
        </div>
        <div style="align-self:end;">
          <button class="primary" id="btnDeposit">Deposit</button>
        </div>
      </div>
      <div class="muted" style="margin-top:10px;">
        Banking signal: amounts converted to <code>amountCents</code> to avoid float bugs.
      </div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 10px;">3) Transfer (Idempotent)</h2>
      <div class="row">
        <div style="min-width:240px;">
          <label>From</label>
          <select id="fromAccount"></select>
        </div>
        <div style="min-width:240px;">
          <label>To</label>
          <select id="toAccount"></select>
        </div>
        <div>
          <label>Amount (PHP)</label>
          <input id="transferAmount" type="number" step="0.01" placeholder="e.g. 120.00" />
        </div>
        <div style="min-width:220px;">
          <label>Idempotency-Key</label>
          <input id="idemKey" placeholder="demo-1 (optional)" />
        </div>
        <div style="align-self:end;">
          <button class="primary" id="btnTransfer">Transfer</button>
        </div>
      </div>
      <div class="muted" style="margin-top:10px;">
        JD tie-in: reliability & scaling — safe retries using <code>Idempotency-Key</code>.
      </div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 10px;">4) Ledger (Audit trail)</h2>
      <div class="row">
        <div style="min-width:240px;">
          <label>Account</label>
          <select id="ledgerAccount"></select>
        </div>
        <div style="align-self:end;">
          <button class="primary" id="btnLedger">Load ledger</button>
        </div>
      </div>
      <div id="ledger" style="margin-top:12px;"></div>
    </div>

    <div class="card" style="grid-column:1 / -1;">
      <h2 style="margin:0 0 10px;">Response</h2>
      <div class="muted">This makes debugging easy (JD: troubleshoot backend issues).</div>
      <pre id="out">{}</pre>
    </div>
  </div>

<script>
  const $ = (id) => document.getElementById(id);

  const storeKey = 'wallet-ledger-ui-accounts';
  const loadAccounts = () => JSON.parse(localStorage.getItem(storeKey) || '[]');
  const saveAccounts = (accs) => localStorage.setItem(storeKey, JSON.stringify(accs));

  function phpToCents(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }

  async function apiGet(path) {
    const r = await fetch(path);
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  async function apiPost(path, body, headers = {}) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  function setOut(obj) {
    $('out').textContent = JSON.stringify(obj, null, 2);
  }

  function renderAccountSelects(accounts) {
    const opts = accounts.map(a => \`<option value="\${a.id}">\${a.id} (\${a.currency})</option>\`).join('');
    $('depositAccount').innerHTML = opts;
    $('fromAccount').innerHTML = opts;
    $('toAccount').innerHTML = opts;
    $('ledgerAccount').innerHTML = opts;
  }

  function renderAccountsList(accounts) {
    if (!accounts.length) {
      $('accountsList').innerHTML = '<div class="muted">No accounts yet.</div>';
      return;
    }
    $('accountsList').innerHTML = accounts.map(a =>
      \`<div class="row" style="justify-content:space-between; border-bottom:1px solid #eee; padding:8px 0;">
        <div><span class="pill">\${a.currency}</span> <code>\${a.id}</code></div>
        <button data-del="\${a.id}">Remove</button>
      </div>\`
    ).join('');
    // bind remove
    document.querySelectorAll('button[data-del]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-del');
        const next = loadAccounts().filter(a => a.id !== id);
        saveAccounts(next);
        boot();
      };
    });
  }

  async function refreshBalances(accounts) {
    const rows = [];
    for (const a of accounts) {
      const res = await apiGet(\`/accounts/\${a.id}/balance\`);
      rows.push({ id: a.id, currency: a.currency, ...res.data });
    }
    $('balances').innerHTML =
      '<table><thead><tr><th>Account</th><th>Currency</th><th>Balance (cents)</th></tr></thead><tbody>' +
      rows.map(r => \`<tr><td><code>\${r.id}</code></td><td>\${r.currency}</td><td>\${r.balanceCents ?? '-'}</td></tr>\`).join('') +
      '</tbody></table>';
  }

  async function boot() {
    const accounts = loadAccounts();
    renderAccountSelects(accounts);
    renderAccountsList(accounts);
    $('balances').innerHTML = '';
    $('ledger').innerHTML = '';
  }

  $('btnCreate').onclick = async () => {
    const currency = $('currency').value;
    const res = await apiPost('/accounts', { currency });
    setOut(res);
    if (res.ok && res.data.account) {
      const accounts = loadAccounts();
      accounts.push(res.data.account);
      saveAccounts(accounts);
      boot();
    }
  };

  $('btnDeposit').onclick = async () => {
    const id = $('depositAccount').value;
    const cents = phpToCents($('depositAmount').value);
    if (!id || cents == null || cents <= 0) return setOut({ error: 'Enter a valid amount.' });

    const res = await apiPost(\`/accounts/\${id}/deposit\`, { amountCents: cents });
    setOut(res);
  };

  $('btnTransfer').onclick = async () => {
    const from = $('fromAccount').value;
    const to = $('toAccount').value;
    const cents = phpToCents($('transferAmount').value);
    if (!from || !to || from === to) return setOut({ error: 'Pick different From/To accounts.' });
    if (cents == null || cents <= 0) return setOut({ error: 'Enter a valid amount.' });

    let key = $('idemKey').value.trim();
    if (!key) key = 'ui-' + Math.random().toString(16).slice(2);

    const res = await apiPost(
      '/transfers',
      { fromAccountId: from, toAccountId: to, amountCents: cents },
      { 'Idempotency-Key': key }
    );
    setOut({ idemKey: key, ...res });
  };

  $('btnRefresh').onclick = async () => {
    const accounts = loadAccounts();
    await refreshBalances(accounts);
  };

  $('btnLedger').onclick = async () => {
    const id = $('ledgerAccount').value;
    if (!id) return setOut({ error: 'Create/select an account first.' });
    const res = await apiGet(\`/accounts/\${id}/ledger\`);
    setOut(res);

    const entries = (res.data && res.data.entries) || [];
    if (!entries.length) {
      $('ledger').innerHTML = '<div class="muted">No ledger entries yet.</div>';
      return;
    }
    $('ledger').innerHTML =
      '<table><thead><tr><th>Time</th><th>Type</th><th>Dir</th><th>Amount</th><th>Ref</th></tr></thead><tbody>' +
      entries.map(e =>
        \`<tr>
          <td>\${e.createdAt}</td>
          <td>\${e.type}</td>
          <td>\${e.direction}</td>
          <td>\${e.amountCents}</td>
          <td><code>\${e.referenceId}</code></td>
        </tr>\`
      ).join('') +
      '</tbody></table>';
  };

  $('btnReset').onclick = () => {
    localStorage.removeItem(storeKey);
    setOut({ ok: true, message: 'UI reset (local only).' });
    boot();
  };

  boot();
</script>
</body>
</html>`);
});

// ---------- Helpers ----------
const accountKey = (id: string) => `account:${id}`;
const ledgerPrefix = (accountId: string) => `ledger:${accountId}:`;
const ledgerKey = (accountId: string, ts: number, entryId: string) => `ledger:${accountId}:${String(ts).padStart(13, '0')}:${entryId}`;

async function getAccount(env: Bindings, id: string): Promise<Account | null> {
	const a = await env.ACCOUNTS.get(accountKey(id), { type: 'json' });
	return (a as Account) ?? null;
}

async function listLedger(env: Bindings, accountId: string): Promise<LedgerEntry[]> {
	const listed = await env.LEDGER.list({ prefix: ledgerPrefix(accountId), limit: 500 });
	const entries: LedgerEntry[] = [];
	for (const k of listed.keys) {
		const e = await env.LEDGER.get(k.name, { type: 'json' });
		if (e) entries.push(e as LedgerEntry);
	}
	// keys are timestamp-ordered; keep explicit sort anyway
	entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return entries;
}

async function getBalanceCents(env: Bindings, accountId: string): Promise<number> {
	const entries = await listLedger(env, accountId);
	let bal = 0;
	for (const e of entries) {
		bal += e.direction === 'CREDIT' ? e.amountCents : -e.amountCents;
	}
	return bal;
}

// ---------- Schemas ----------
const CreateAccountSchema = z.object({
	currency: z.string().min(3).max(10).default('PHP'),
});

const AmountSchema = z.object({
	amountCents: z.number().int().positive(),
});

const TransferSchema = z.object({
	fromAccountId: z.string().min(4),
	toAccountId: z.string().min(4),
	amountCents: z.number().int().positive(),
});

// ---------- Routes ----------
app.post('/accounts', async (c) => {
	// JD: "Design/develop backend systems" + "APIs"
	const body = CreateAccountSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!body.success) return c.json({ error: { code: 'VALIDATION', issues: body.error.issues } }, 400);

	const id = nanoid(12);
	const account: Account = {
		id,
		currency: body.data.currency,
		createdAt: new Date().toISOString(),
	};

	await c.env.ACCOUNTS.put(accountKey(id), JSON.stringify(account));
	return c.json({ account }, 201);
});

app.get('/accounts/:id/balance', async (c) => {
	const id = c.req.param('id');
	const acc = await getAccount(c.env, id);
	if (!acc) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

	const balanceCents = await getBalanceCents(c.env, id);
	return c.json({ accountId: id, currency: acc.currency, balanceCents });
});

app.get('/accounts/:id/ledger', async (c) => {
	const id = c.req.param('id');
	const acc = await getAccount(c.env, id);
	if (!acc) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

	const entries = await listLedger(c.env, id);
	return c.json({ accountId: id, entries });
});

app.post('/accounts/:id/deposit', async (c) => {
	// JD: "Build/enhance APIs" + "Write secure code" (validate) + "Auditability" (ledger)
	const id = c.req.param('id');
	const acc = await getAccount(c.env, id);
	if (!acc) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

	const body = AmountSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!body.success) return c.json({ error: { code: 'VALIDATION', issues: body.error.issues } }, 400);

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
	/**
	 * JD mapping:
	 * - "Optimize performance & ensure systems scale": idempotency for safe retries
	 * - "Write clean, secure code": validation + consistent errors
	 * - Digital bank correctness signal: use integer cents, append-only ledger entries
	 */
	const idemKey = c.req.header('Idempotency-Key');
	if (!idemKey) {
		return c.json({ error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header required' } }, 400);
	}

	const idemStoreKey = `idem:transfer:${idemKey}`;
	const existing = await c.env.IDEMPOTENCY.get(idemStoreKey, { type: 'json' });
	if (existing) {
		return c.json({ idempotentReplay: true, ...(existing as object) });
	}

	const body = TransferSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!body.success) return c.json({ error: { code: 'VALIDATION', issues: body.error.issues } }, 400);

	const { fromAccountId, toAccountId, amountCents } = body.data;
	if (fromAccountId === toAccountId) {
		return c.json({ error: { code: 'INVALID_TRANSFER', message: 'fromAccountId and toAccountId must differ' } }, 400);
	}

	const from = await getAccount(c.env, fromAccountId);
	const to = await getAccount(c.env, toAccountId);
	if (!from || !to) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);
	if (from.currency !== to.currency) {
		return c.json({ error: { code: 'CURRENCY_MISMATCH', message: 'Accounts must have same currency in this prototype' } }, 400);
	}

	const fromBal = await getBalanceCents(c.env, fromAccountId);
	if (fromBal < amountCents) {
		return c.json({ error: { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds' } }, 409);
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

	await c.env.LEDGER.put(ledgerKey(fromAccountId, ts, debit.id), JSON.stringify(debit));
	await c.env.LEDGER.put(ledgerKey(toAccountId, ts, credit.id), JSON.stringify(credit));

	const result = {
		transferId,
		fromAccountId,
		toAccountId,
		amountCents,
		currency: from.currency,
		// derived “expected” balances (fast + stable for response)
		fromBalanceCents: fromBal - amountCents,
	};

	// store idempotent result (so retries are safe)
	await c.env.IDEMPOTENCY.put(idemStoreKey, JSON.stringify(result));

	return c.json(result, 201);
});

export default app;
