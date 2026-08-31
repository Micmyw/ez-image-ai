import assert from "node:assert/strict";
import test from "node:test";

import { assertLocalMediaE2E } from "./guard";

void test("accepts the unified SaaS origin without a separate marketing service", () => {
	const environment = {
		NODE_ENV: "test",
		E2E_TEST_MEDIA_ADAPTERS: "true",
		MEDIA_SAFETY_ADAPTER: "test",
		MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
		E2E_RUN_ID: "unified-landing",
		DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/ezpic_testing",
		TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/ezpic_testing",
		NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
	} satisfies NodeJS.ProcessEnv;

	assert.deepEqual(assertLocalMediaE2E(environment), {
		databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/ezpic_testing",
		runId: "unified-landing",
		saasOrigin: "http://localhost:3000",
	});
});
