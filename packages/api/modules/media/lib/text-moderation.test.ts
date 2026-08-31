import { describe, expect, it, vi } from "vitest";

import {
	createTextModerationAdapter,
	moderateQuoteInput,
	TEXT_MODERATION_RULE_VERSION,
} from "./text-moderation";

describe("generation text moderation", () => {
	const quote = {
		ownerType: "USER" as const,
		ownerId: "user_1",
		submittedByUserId: "user_1",
		productKey: "image-fast",
		catalogVersion: "catalog-v1",
		pricingVersion: "pricing-v1",
		credits: 4n,
		costMicros: 100n,
		inputSnapshot: { kind: "text-to-image", prompt: "private prompt" },
		pricingSnapshot: {},
		expiresAt: new Date("2026-08-14T01:00:00.000Z"),
	};

	it.each(["REJECT", "REVIEW", "ERROR"] as const)(
		"fails closed for a %s decision without persisting an approved quote",
		async (decision) => {
			const persistApproved = vi.fn();
			const recordDenied = vi.fn(async () => undefined);
			await expect(
				moderateQuoteInput(quote, {
					provider: "test",
					moderateText: vi.fn(async () => ({
						decision,
						reasonCode: `TEST_${decision}`,
						ruleVersion: TEXT_MODERATION_RULE_VERSION,
					})),
					persistApproved,
					recordDenied,
				}),
			).rejects.toThrow(`TEXT_MODERATION_${decision}`);
			expect(persistApproved).not.toHaveBeenCalled();
			expect(recordDenied).toHaveBeenCalledWith(
				expect.objectContaining({ decision, provider: "test" }),
			);
			expect(JSON.stringify(recordDenied.mock.calls)).not.toContain("private prompt");
		},
	);

	it("persists one approved evidence snapshot after exactly one adapter call", async () => {
		const moderateText = vi.fn(async () => ({
			decision: "ALLOW" as const,
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: TEXT_MODERATION_RULE_VERSION,
		}));
		const persistApproved = vi.fn(async (evidence) => ({ id: "quote_1", evidence }));
		const recordDenied = vi.fn();
		await expect(
			moderateQuoteInput(
				{ ...quote, inputSnapshot: { kind: "text-to-image", prompt: "approved prompt" } },
				{ provider: "test", moderateText, persistApproved, recordDenied },
			),
		).resolves.toMatchObject({ id: "quote_1" });
		expect(moderateText).toHaveBeenCalledOnce();
		expect(persistApproved).toHaveBeenCalledWith(
			expect.objectContaining({
				decision: "ALLOW",
				provider: "test",
				inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		);
		expect(recordDenied).not.toHaveBeenCalled();
	});

	it("requires an explicit test-adapter switch and forbids it in production", () => {
		expect(() =>
			createTextModerationAdapter({ NODE_ENV: "test", MEDIA_SAFETY_ADAPTER: "test" }),
		).toThrow("TEST_SAFETY_ADAPTER_DISABLED");
		expect(() =>
			createTextModerationAdapter({
				NODE_ENV: "production",
				MEDIA_SAFETY_ADAPTER: "test",
				MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
			}),
		).toThrow(/production/i);
	});

	it("allows the test adapter only for a complete local production-build E2E identity", async () => {
		const { adapter, provider } = createTextModerationAdapter(localProductionE2EEnvironment());
		expect(provider).toBe("test");
		await expect(
			adapter.moderateText({ text: "local E2E prompt", ruleVersion: "test-rule" }),
		).resolves.toMatchObject({ decision: "ALLOW", ruleVersion: "test-rule" });
	});

	it.each([
		["production-build opt-in", { E2E_USE_PRODUCTION_BUILD: undefined }],
		["media adapter opt-in", { E2E_TEST_MEDIA_ADAPTERS: undefined }],
		["valid run id", { E2E_RUN_ID: "invalid_run_id" }],
		["declared test database", { TEST_DATABASE_URL: "postgresql://localhost/other_test" }],
		["loopback database", { DATABASE_URL: "postgresql://database.example/media_test" }],
		["test database name", { DATABASE_URL: "postgresql://localhost/media" }],
		["loopback SaaS origin", { NEXT_PUBLIC_SAAS_URL: "https://saas.example" }],
		["matching public origin", { NEXT_PUBLIC_MARKETING_URL: "http://localhost:3001" }],
	] as const)("keeps production closed without a %s", (_boundary, overrides) => {
		expect(() =>
			createTextModerationAdapter({ ...localProductionE2EEnvironment(), ...overrides }),
		).toThrow(/production/i);
	});

	it("fails closed when production Sightengine credentials are missing", () => {
		expect(() =>
			createTextModerationAdapter({
				NODE_ENV: "production",
				MEDIA_SAFETY_ADAPTER: "sightengine",
			}),
		).toThrow("TEXT_MODERATION_CONFIGURATION_ERROR");
	});
});

function localProductionE2EEnvironment(): Record<string, string | undefined> {
	const databaseUrl = "postgresql://media:media@127.0.0.1:55432/media_e2e_test";
	return {
		NODE_ENV: "production",
		E2E_USE_PRODUCTION_BUILD: "true",
		E2E_TEST_MEDIA_ADAPTERS: "true",
		E2E_RUN_ID: "media-e2e-123",
		DATABASE_URL: databaseUrl,
		TEST_DATABASE_URL: databaseUrl,
		NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
		NEXT_PUBLIC_MARKETING_URL: "http://localhost:3000",
		MEDIA_SAFETY_ADAPTER: "test",
		MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
	};
}
