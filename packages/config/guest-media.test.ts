import { describe, expect, it } from "vitest";

import { getGuestMediaConfig } from "./guest-media";
import { getPublicGuestMediaConfig } from "./public";

const developmentEnvironment = {
	NODE_ENV: "development",
	GUEST_MEDIA_ENABLED: "true",
	GUEST_PROMOTION_PERIOD: "2026-launch",
};

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
			queueTtlMs: 15 * 60 * 1_000,
		});
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
