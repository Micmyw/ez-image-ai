import { describe, expect, it } from "vitest";

import { getGuestMediaConfig } from "./guest-media";
import { getPublicGuestMediaConfig } from "./public";

const developmentEnvironment = {
	NODE_ENV: "development",
	GUEST_MEDIA_ENABLED: "true",
	GUEST_PROMOTION_PERIOD: "2026-launch",
};

const productionEnvironment = {
	...developmentEnvironment,
	NODE_ENV: "production",
	GUEST_COST_EVIDENCE_ID: "benchmark-2026-08-27",
	GUEST_HARD_BUDGET_MICROS: "10000000",
	GUEST_RISK_BUDGET_MICROS: "350000",
	NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: "site-key",
	GUEST_TURNSTILE_SECRET_KEY: "secret-key",
	MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
	GUEST_QUEUE_TTL_SECONDS: "600",
	GUEST_QUEUE_MAX_DEPTH: "25",
	GUEST_BOOTSTRAP_MAX_OUTSTANDING: "25",
	GUEST_TEMPORARY_PRINCIPAL_MAX_TOTAL: "100",
	GUEST_SESSION_MAX_ACTIVE_JOBS: "1",
	GUEST_SESSION_MAX_ACCEPTED_TRIALS: "1",
	GUEST_DEVICE_MAX_ACTIVE_JOBS: "1",
	GUEST_DEVICE_MAX_ACCEPTED_PER_PROMOTION: "1",
	GUEST_IP_MAX_ACTIVE_JOBS: "2",
	GUEST_IP_MAX_PER_10_MINUTES: "1",
	GUEST_IP_MAX_PER_24_HOURS: "3",
	GUEST_SUBNET_MAX_PER_24_HOURS: "20",
	GUEST_GLOBAL_MAX_PER_MINUTE: "3",
	GUEST_GLOBAL_MAX_PER_HOUR: "30",
	GUEST_GLOBAL_MAX_PER_24_HOURS: "100",
	GUEST_ABUSE_EVIDENCE_TTL_DAYS: "30",
} as const;

describe("guest media configuration", () => {
	it("exposes the fixed Standard trial envelope in non-production", () => {
		expect(getGuestMediaConfig(developmentEnvironment, true)).toMatchObject({
			enabled: true,
			reason: null,
			promotionPeriod: "2026-launch",
			productKey: "image-fast",
			sponsorCredits: 4n,
			maximumBytes: 10 * 1024 * 1024,
			mimeTypes: ["image/jpeg", "image/png", "image/webp"],
			retentionMs: 24 * 60 * 60 * 1_000,
			queueTtlMs: 10 * 60 * 1_000,
			riskBudgetMicros: 350_000n,
			limits: {
				maximumActiveJobsPerGuest: 1,
				maximumAcceptedTrialsPerSession: 1,
				maximumAcceptedTrialsPerDevicePromotion: 1,
				maximumActiveJobsPerIp: 2,
				maximumRequestsPerIpPerTenMinutes: 1,
				maximumRequestsPerIpPerDay: 3,
				maximumRequestsPerSubnetPerDay: 20,
				maximumGlobalRequestsPerMinute: 3,
				maximumGlobalRequestsPerHour: 30,
				maximumGlobalRequestsPerDay: 100,
				maximumGlobalQueueDepth: 25,
				maximumOutstandingBootstraps: 25,
				maximumTemporaryPrincipals: 100,
			},
		});
	});

	it("fails production closed unless every abuse and capacity limit is explicit and positive", () => {
		const production = {
			...productionEnvironment,
			GUEST_QUEUE_TTL_SECONDS: undefined,
			GUEST_QUEUE_MAX_DEPTH: undefined,
			GUEST_BOOTSTRAP_MAX_OUTSTANDING: undefined,
			GUEST_TEMPORARY_PRINCIPAL_MAX_TOTAL: undefined,
			GUEST_SESSION_MAX_ACTIVE_JOBS: undefined,
			GUEST_SESSION_MAX_ACCEPTED_TRIALS: undefined,
			GUEST_DEVICE_MAX_ACTIVE_JOBS: undefined,
			GUEST_DEVICE_MAX_ACCEPTED_PER_PROMOTION: undefined,
			GUEST_IP_MAX_ACTIVE_JOBS: undefined,
			GUEST_IP_MAX_PER_10_MINUTES: undefined,
			GUEST_IP_MAX_PER_24_HOURS: undefined,
			GUEST_SUBNET_MAX_PER_24_HOURS: undefined,
			GUEST_GLOBAL_MAX_PER_MINUTE: undefined,
			GUEST_GLOBAL_MAX_PER_HOUR: undefined,
			GUEST_GLOBAL_MAX_PER_24_HOURS: undefined,
			GUEST_ABUSE_EVIDENCE_TTL_DAYS: undefined,
		};

		expect(getGuestMediaConfig(production, true)).toMatchObject({
			enabled: false,
			reason: "GUEST_CONFIGURATION_INVALID",
		});
		expect(getGuestMediaConfig(productionEnvironment, true)).toMatchObject({
			enabled: true,
			reason: null,
			limits: {
				maximumRequestsPerMinute: 3,
				maximumRequestsPerIpPerHour: 3,
			},
		});
	});

	it.each([
		["GUEST_RISK_BUDGET_MICROS", undefined],
		["GUEST_RISK_BUDGET_MICROS", "350001"],
		["GUEST_QUEUE_TTL_SECONDS", "601"],
		["GUEST_QUEUE_MAX_DEPTH", "26"],
		["GUEST_ABUSE_EVIDENCE_TTL_DAYS", "29"],
		["GUEST_ABUSE_EVIDENCE_TTL_DAYS", "31"],
		["GUEST_SESSION_MAX_ACTIVE_JOBS", "2"],
		["GUEST_SESSION_MAX_ACCEPTED_TRIALS", "2"],
		["GUEST_DEVICE_MAX_ACTIVE_JOBS", "2"],
		["GUEST_DEVICE_MAX_ACCEPTED_PER_PROMOTION", "2"],
		["GUEST_IP_MAX_ACTIVE_JOBS", "3"],
		["GUEST_IP_MAX_PER_10_MINUTES", "2"],
		["GUEST_IP_MAX_PER_24_HOURS", "4"],
		["GUEST_SUBNET_MAX_PER_24_HOURS", "21"],
		["GUEST_GLOBAL_MAX_PER_MINUTE", "4"],
		["GUEST_GLOBAL_MAX_PER_HOUR", "31"],
		["GUEST_GLOBAL_MAX_PER_24_HOURS", "101"],
		["GUEST_BOOTSTRAP_MAX_OUTSTANDING", "26"],
		["GUEST_TEMPORARY_PRINCIPAL_MAX_TOTAL", "101"],
	] as const)("fails production closed when %s is outside the frozen envelope", (key, value) => {
		expect(getGuestMediaConfig({ ...productionEnvironment, [key]: value }, true)).toMatchObject({
			enabled: false,
			reason: "GUEST_CONFIGURATION_INVALID",
		});
	});

	it("accepts stricter positive production limits while keeping evidence at exactly 30 days", () => {
		expect(
			getGuestMediaConfig(
				{
					...productionEnvironment,
					GUEST_RISK_BUDGET_MICROS: "1",
					GUEST_QUEUE_TTL_SECONDS: "1",
					GUEST_QUEUE_MAX_DEPTH: "1",
					GUEST_BOOTSTRAP_MAX_OUTSTANDING: "1",
					GUEST_TEMPORARY_PRINCIPAL_MAX_TOTAL: "1",
					GUEST_IP_MAX_ACTIVE_JOBS: "1",
					GUEST_IP_MAX_PER_24_HOURS: "1",
					GUEST_SUBNET_MAX_PER_24_HOURS: "1",
					GUEST_GLOBAL_MAX_PER_HOUR: "1",
					GUEST_GLOBAL_MAX_PER_24_HOURS: "1",
				},
				true,
			),
		).toMatchObject({ enabled: true, reason: null, riskBudgetMicros: 1n });
	});

	it.each([null, undefined, false, { enabled: true }, { enabled: false }])(
		"requires the exact literal runtime override for %j",
		(runtimeOverride) => {
			expect(getGuestMediaConfig(developmentEnvironment, runtimeOverride)).toMatchObject({
				enabled: false,
				reason: "GUEST_RUNTIME_DISABLED",
			});
		},
	);

	it("requires both the environment gate and the literal runtime override", () => {
		expect(
			getGuestMediaConfig({ ...developmentEnvironment, GUEST_MEDIA_ENABLED: "false" }, true),
		).toMatchObject({ enabled: false, reason: "GUEST_ENVIRONMENT_DISABLED" });
	});

	it.each([undefined, "", "staging", "preview", false])(
		"fails closed for missing or unknown NODE_ENV %j",
		(nodeEnvironment) => {
			expect(
				getGuestMediaConfig({ ...developmentEnvironment, NODE_ENV: nodeEnvironment }, true),
			).toMatchObject({ enabled: false, reason: "GUEST_ENVIRONMENT_INVALID" });
		},
	);

	it("fails closed when production guest cost evidence or hard-budget evidence is absent", () => {
		expect(
			getGuestMediaConfig(
				{
					...developmentEnvironment,
					NODE_ENV: "production",
					NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: "site-key",
					GUEST_TURNSTILE_SECRET_KEY: "secret-key",
					MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
				},
				true,
			),
		).toMatchObject({
			enabled: false,
			reason: "GUEST_PRODUCTION_EVIDENCE_REQUIRED",
		});
	});

	it("fails closed on incomplete production bot and proxy controls", () => {
		const production = {
			...developmentEnvironment,
			NODE_ENV: "production",
			GUEST_COST_EVIDENCE_ID: "benchmark-2026-08-27",
			GUEST_HARD_BUDGET_MICROS: "10000000",
		};
		expect(getGuestMediaConfig(production, true)).toMatchObject({
			enabled: false,
			reason: "GUEST_PRODUCTION_TURNSTILE_REQUIRED",
		});
		expect(
			getGuestMediaConfig(
				{
					...production,
					NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: "site-key",
					GUEST_TURNSTILE_SECRET_KEY: "secret-key",
				},
				true,
			),
		).toMatchObject({ enabled: false, reason: "GUEST_PRODUCTION_TRUSTED_PROXY_REQUIRED" });
	});

	it("permits the guest path only for a complete loopback production-build E2E identity", () => {
		const localDatabase = "postgresql://postgres:postgres@127.0.0.1:55432/guest_media_testing";
		const localProductionE2E = {
			...developmentEnvironment,
			NODE_ENV: "production",
			E2E_USE_PRODUCTION_BUILD: "true",
			E2E_TEST_MEDIA_ADAPTERS: "true",
			E2E_RUN_ID: "guest-e2e-123",
			MEDIA_PROVIDER_ADAPTER: "mock",
			MEDIA_SAFETY_ADAPTER: "test",
			MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
			DATABASE_URL: localDatabase,
			TEST_DATABASE_URL: localDatabase,
			NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
			NEXT_PUBLIC_MARKETING_URL: "http://localhost:3001",
		};

		expect(getGuestMediaConfig(localProductionE2E, true)).toMatchObject({
			enabled: true,
			reason: null,
			turnstile: { required: false, siteKey: null, secretKey: null },
			trustedProxyPolicy: { provider: "none", required: false },
		});
		expect(
			getGuestMediaConfig({ ...localProductionE2E, TEST_DATABASE_URL: "" }, true),
		).toMatchObject({
			enabled: false,
			reason: "GUEST_PRODUCTION_EVIDENCE_REQUIRED",
		});
	});

	it("keeps server evidence, budgets, and the Turnstile secret out of the public projection", () => {
		const serverConfig = getGuestMediaConfig(
			{
				...developmentEnvironment,
				GUEST_COST_EVIDENCE_ID: "private-evidence",
				GUEST_HARD_BUDGET_MICROS: "10000000",
				GUEST_RISK_BUDGET_MICROS: "250000",
				GUEST_TURNSTILE_SECRET_KEY: "private-turnstile-secret",
				NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: "public-site-key",
			},
			true,
		);
		const serialized = JSON.stringify(getPublicGuestMediaConfig(serverConfig));

		expect(serialized).toContain("public-site-key");
		expect(serialized).not.toContain("private-evidence");
		expect(serialized).not.toContain("private-turnstile-secret");
		expect(serialized).not.toContain("10000000");
		expect(serialized).not.toContain("250000");
	});
});
