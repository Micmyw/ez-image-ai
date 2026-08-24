import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { createQuoteForUser } from "./create-quote";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";

const INPUT = {
	productKey: "image-fast" as const,
	input: {
		kind: "image-to-image" as const,
		prompt: "private prompt",
		sourceAssetId: SOURCE_ASSET_ID,
	},
};

describe("createQuoteForUser", () => {
	it("persists a quote only after one ALLOW decision", async () => {
		const persistApproved = vi.fn(async (quote) => ({ id: "quote_1", ...quote }));
		const moderateText = vi.fn(async ({ ruleVersion }) => ({
			decision: "ALLOW" as const,
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion,
		}));
		const assertAllowed = vi.fn(async () => undefined);
		await expect(
			createQuoteForUser("user_1", INPUT, {
				now: () => new Date("2026-08-14T00:00:00.000Z"),
				assertAllowed,
				createAdapter: () => ({ provider: "sightengine", adapter: { moderateText } }),
				persistApproved,
				recordDenied: vi.fn(),
			}),
		).resolves.toMatchObject({ id: "quote_1" });
		expect(assertAllowed).toHaveBeenCalledOnce();
		expect(moderateText).toHaveBeenCalledOnce();
		expect(persistApproved).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerId: "user_1",
				inputSnapshot: INPUT.input,
				moderation: expect.objectContaining({
					decision: "ALLOW",
					inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			}),
		);
	});

	it("rejects quality text-to-image input before moderation or persistence", async () => {
		const createAdapter = vi.fn();
		const persistApproved = vi.fn();
		const assertAllowed = vi.fn();

		await expect(
			createQuoteForUser(
				"user_1",
				{
					productKey: "image-quality",
					input: {
						kind: "text-to-image",
						prompt: "Create a studio product photo",
					},
				},
				{
					now: () => new Date("2026-08-24T00:00:00.000Z"),
					assertAllowed,
					createAdapter,
					persistApproved,
					recordDenied: vi.fn(),
				},
			),
		).rejects.toThrow("Input text-to-image is not supported by image-quality");

		expect(assertAllowed).not.toHaveBeenCalled();
		expect(createAdapter).not.toHaveBeenCalled();
		expect(persistApproved).not.toHaveBeenCalled();
	});

	it.each(["REJECT", "REVIEW", "ERROR"] as const)(
		"records prompt-free %s evidence and creates no quote",
		async (decision) => {
			const persistApproved = vi.fn();
			const recordDenied = vi.fn(async () => undefined);
			await expect(
				createQuoteForUser("user_1", INPUT, {
					now: () => new Date("2026-08-14T00:00:00.000Z"),
					assertAllowed: vi.fn(async () => undefined),
					createAdapter: () => ({
						provider: "sightengine",
						adapter: {
							moderateText: vi.fn(async ({ ruleVersion }) => ({
								decision,
								reasonCode: `TEST_${decision}`,
								ruleVersion,
							})),
						},
					}),
					persistApproved,
					recordDenied,
				}),
			).rejects.toThrow(`TEXT_MODERATION_${decision}`);
			expect(persistApproved).not.toHaveBeenCalled();
			expect(recordDenied).toHaveBeenCalledOnce();
			expect(JSON.stringify(recordDenied.mock.calls)).not.toContain("private prompt");
		},
	);
});
