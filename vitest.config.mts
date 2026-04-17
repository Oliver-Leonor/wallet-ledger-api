import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Miniflare bindings for the test environment.
 *
 * We deliberately don't read the real KV namespace IDs from wrangler.jsonc;
 * Miniflare creates isolated in-memory KV stores per run, which means tests
 * can freely create/deposit/transfer without touching production data.
 *
 * DEMO_API_TOKEN is set here to a known value so test specs can authenticate
 * against the worker without needing `wrangler secret put`.
 */
export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					kvNamespaces: ['ACCOUNTS', 'LEDGER', 'IDEMPOTENCY'],
					bindings: {
						DEMO_API_TOKEN: 'test-token-for-specs',
					},
				},
			},
		},
	},
});
