import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { resolveEzPicProductionLoadPlan } from "../../packages/config/production-load";

const execute = process.argv.includes("--execute");
const dryRunDefaults = {
	LOAD_BASE_URL: "http://127.0.0.1:3000",
	LOAD_MARKETING_BASE_URL: "http://127.0.0.1:3001",
	LOAD_PROFILE: "smoke",
	LOAD_TEST_RUN_ID: "pr8-local-dry-run",
	LOAD_MAX_REQUESTS: "120",
	LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS: "0",
	LOAD_PROVIDER_CALLS_ENABLED: "false",
	LOAD_MAX_ERROR_RATE_BPS: "100",
	LOAD_MARKETING_P95_MS: "1000",
	LOAD_UPLOAD_P95_MS: "2000",
	LOAD_QUOTE_CREATE_P95_MS: "1500",
	LOAD_POLLING_P95_MS: "800",
	LOAD_SIGNED_URL_P95_MS: "800",
	LOAD_ADMIN_AGGREGATE_P95_MS: "2000",
} as const;
const plan = resolveEzPicProductionLoadPlan(
	execute ? process.env : { ...dryRunDefaults, ...process.env },
);

console.log(
	JSON.stringify({
		status: execute ? "EXECUTION_REQUESTED" : "NOT_COMPLETED",
		reason: execute ? undefined : "Dry-run plan only; k6 was not started.",
		profile: plan.profile,
		runId: plan.runId,
		targetEnvironment: plan.targetEnvironment,
		saasOrigin: plan.saasOrigin,
		marketingOrigin: plan.marketingOrigin,
		scenarios: plan.scenarios,
		plannedRequests: plan.plannedRequests,
		maximumRequests: plan.maximumRequests,
		plannedProviderInvocations: plan.plannedProviderInvocations,
		plannedProviderCostMicros: plan.plannedProviderCostMicros.toString(),
		maximumExpectedProviderCostMicros: plan.maximumExpectedProviderCostMicros.toString(),
	}),
);

if (!execute) process.exit(0);
if (process.env.LOAD_EXECUTION_CONFIRMATION !== `${plan.runId}:execute`) {
	throw new Error("LOAD_EXECUTION_CONFIRMATION must exactly confirm the run before k6 starts");
}
if (plan.remote && plan.scenarios.includes("quote-create") && !plan.providerCallsEnabled) {
	throw new Error(
		"Remote quote-create execution is NOT_COMPLETED until bounded staging Provider calls are explicitly enabled",
	);
}

const executable = process.platform === "win32" ? "k6.exe" : "k6";
const result = spawnSync(executable, ["run", resolve("tests/load/ezpic-production.js")], {
	cwd: process.cwd(),
	env: process.env,
	stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
