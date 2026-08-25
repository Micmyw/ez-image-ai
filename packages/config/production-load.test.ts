import { describe, expect, it } from "vitest";

import { EZPIC_LOAD_SCENARIOS, resolveEzPicProductionLoadPlan } from "./production-load";

const localEnvironment = {
	LOAD_BASE_URL: "http://127.0.0.1:3000",
	LOAD_MARKETING_BASE_URL: "http://127.0.0.1:3001",
	LOAD_PROFILE: "smoke",
	LOAD_TEST_RUN_ID: "pr8-local-smoke",
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

const confirmedRemoteEnvironment = {
	...localEnvironment,
	LOAD_BASE_URL: "https://staging-app.ezpic.example",
	LOAD_MARKETING_BASE_URL: "https://staging.ezpic.example",
	ALLOW_REMOTE_LOAD_TARGET: "true",
	LOAD_REMOTE_TARGET_ALLOWLIST: "https://staging-app.ezpic.example,https://staging.ezpic.example",
	LOAD_TARGET_CONFIRMATION: "https://staging-app.ezpic.example|https://staging.ezpic.example",
	LOAD_TARGET_ENVIRONMENT: "staging",
	LOAD_TARGET_ENVIRONMENT_CONFIRMATION: "staging",
} as const;

describe("EzPic production-like load plan", () => {
	it("covers every required launch surface with an isolated loopback default", () => {
		expect(EZPIC_LOAD_SCENARIOS).toEqual([
			"marketing",
			"upload-concurrency",
			"quote-create",
			"polling",
			"signed-url",
			"admin-aggregate",
		]);
		expect(resolveEzPicProductionLoadPlan(localEnvironment)).toMatchObject({
			profile: "smoke",
			runId: "pr8-local-smoke",
			remote: false,
			maximumRequests: 120,
			maximumExpectedProviderCostMicros: 0n,
			plannedRequests: 80,
			plannedProviderInvocations: 0,
			plannedProviderCostMicros: 0n,
			maximumErrorRateBasisPoints: 100,
			latencyBudgetsMs: {
				marketing: 1_000,
				"upload-concurrency": 2_000,
				"quote-create": 1_500,
				polling: 800,
				"signed-url": 800,
				"admin-aggregate": 2_000,
			},
			scenarios: EZPIC_LOAD_SCENARIOS,
		});
	});

	it("rejects a request ceiling below the selected profile's worst-case plan", () => {
		expect(() =>
			resolveEzPicProductionLoadPlan({ ...localEnvironment, LOAD_MAX_REQUESTS: "79" }),
		).toThrow(/LOAD_MAX_REQUESTS.*80/);
	});

	it.each(["LOAD_MAX_REQUESTS", "LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS"] as const)(
		"rejects a missing %s budget gate",
		(key) => {
			const input: Record<string, string | undefined> = { ...localEnvironment };
			delete input[key];
			expect(() => resolveEzPicProductionLoadPlan(input)).toThrow(new RegExp(key));
		},
	);

	it.each([
		"LOAD_MAX_ERROR_RATE_BPS",
		"LOAD_MARKETING_P95_MS",
		"LOAD_UPLOAD_P95_MS",
		"LOAD_QUOTE_CREATE_P95_MS",
		"LOAD_POLLING_P95_MS",
		"LOAD_SIGNED_URL_P95_MS",
		"LOAD_ADMIN_AGGREGATE_P95_MS",
	] as const)("rejects a missing performance gate %s", (key) => {
		const input: Record<string, string | undefined> = { ...localEnvironment };
		delete input[key];
		expect(() => resolveEzPicProductionLoadPlan(input)).toThrow(new RegExp(key));
	});

	it("rejects Provider calls unless a positive spend budget and exact confirmation are present", () => {
		expect(() =>
			resolveEzPicProductionLoadPlan({
				...confirmedRemoteEnvironment,
				LOAD_PROVIDER_CALLS_ENABLED: "true",
			}),
		).toThrow(/LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS|LOAD_PROVIDER_SPEND_CONFIRMATION/);
	});

	it("rejects Provider calls for a local target even with a confirmed spend budget", () => {
		expect(() =>
			resolveEzPicProductionLoadPlan({
				...localEnvironment,
				LOAD_PROVIDER_CALLS_ENABLED: "true",
				LOAD_PROVIDER_COST_PER_CREATE_MICROS: "3500",
				LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS: "35000",
				LOAD_PROVIDER_SPEND_CONFIRMATION: "pr8-local-smoke:35000",
			}),
		).toThrow(/Provider calls require an explicitly confirmed remote staging target/i);
	});

	it("derives and gates the Provider cost ceiling from quote/create iterations", () => {
		expect(
			resolveEzPicProductionLoadPlan({
				...confirmedRemoteEnvironment,
				LOAD_PROVIDER_CALLS_ENABLED: "true",
				LOAD_PROVIDER_COST_PER_CREATE_MICROS: "3500",
				LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS: "35000",
				LOAD_PROVIDER_SPEND_CONFIRMATION: "pr8-local-smoke:35000",
			}),
		).toMatchObject({
			plannedProviderInvocations: 10,
			plannedProviderCostMicros: 35_000n,
		});
		expect(() =>
			resolveEzPicProductionLoadPlan({
				...confirmedRemoteEnvironment,
				LOAD_PROVIDER_CALLS_ENABLED: "true",
				LOAD_PROVIDER_COST_PER_CREATE_MICROS: "3501",
				LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS: "35000",
				LOAD_PROVIDER_SPEND_CONFIRMATION: "pr8-local-smoke:35000",
			}),
		).toThrow(/planned Provider cost/i);
	});

	it("rejects remote targets without opt-in, allowlist, exact confirmation, and staging identity", () => {
		const remote = {
			...localEnvironment,
			LOAD_BASE_URL: "https://staging-app.ezpic.example",
			LOAD_MARKETING_BASE_URL: "https://staging.ezpic.example",
		};
		for (const override of [
			{},
			{ ALLOW_REMOTE_LOAD_TARGET: "true" },
			{
				ALLOW_REMOTE_LOAD_TARGET: "true",
				LOAD_REMOTE_TARGET_ALLOWLIST:
					"https://staging-app.ezpic.example,https://staging.ezpic.example",
			},
			{
				ALLOW_REMOTE_LOAD_TARGET: "true",
				LOAD_REMOTE_TARGET_ALLOWLIST:
					"https://staging-app.ezpic.example,https://staging.ezpic.example",
				LOAD_TARGET_CONFIRMATION: "https://staging-app.ezpic.example|https://staging.ezpic.example",
			},
		]) {
			expect(() => resolveEzPicProductionLoadPlan({ ...remote, ...override })).toThrow();
		}
	});

	it("accepts only an exactly allowlisted and confirmed staging target", () => {
		expect(
			resolveEzPicProductionLoadPlan({
				...localEnvironment,
				LOAD_BASE_URL: "https://staging-app.ezpic.example",
				LOAD_MARKETING_BASE_URL: "https://staging.ezpic.example",
				ALLOW_REMOTE_LOAD_TARGET: "true",
				LOAD_REMOTE_TARGET_ALLOWLIST:
					"https://staging-app.ezpic.example,https://staging.ezpic.example",
				LOAD_TARGET_CONFIRMATION: "https://staging-app.ezpic.example|https://staging.ezpic.example",
				LOAD_TARGET_ENVIRONMENT: "staging",
				LOAD_TARGET_ENVIRONMENT_CONFIRMATION: "staging",
			}),
		).toMatchObject({ remote: true, targetEnvironment: "staging" });
	});
});
