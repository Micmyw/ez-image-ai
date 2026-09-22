import { fingerprintGenerationQuoteSecurityPayload } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { signTemporaryReference } from "../lib/temporary-reference-token";
import { createQuoteInputSchema } from "../types";
import { createQuoteForUser } from "./create-quote";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";

const INPUT = {
	productKey: "image-nano-banana-2-lite" as const,
	input: {
		kind: "image-to-image" as const,
		prompt: "private prompt",
		sourceAssetId: SOURCE_ASSET_ID,
		skuKey: "nano-banana-2-lite-1k" as const,
		aspectRatio: "auto" as const,
	},
};

describe("createQuoteForUser", () => {
	afterEach(() => vi.unstubAllEnvs());
	it("freezes a signed reference into the text-approved quote fingerprint", async () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "local-temporary-reference-test-key");
		const now = new Date("2026-09-22T12:00:00Z");
		const reference = {
			v: 1 as const,
			ownerId: "user_1",
			assetId: crypto.randomUUID(),
			contentType: "image/png" as const,
			bytes: 100,
			checksum: "a".repeat(64),
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
		};
		const assertAllowed = vi.fn(async () => undefined);
		const persistApproved = vi.fn(async (quote) => ({ id: "temporary-quote", ...quote }));
		await createQuoteForUser(
			"user_1",
			{
				...INPUT,
				input: { ...INPUT.input, sourceAssetId: reference.assetId },
				temporaryReferenceToken: signTemporaryReference(reference),
			},
			{
				now: () => now,
				assertAllowed,
				persistApproved,
				recordDenied: vi.fn(),
				createAdapter: () => ({
					provider: "waffo",
					adapter: {
						moderateText: async ({ ruleVersion }) => ({
							decision: "ALLOW",
							reasonCode: "NO_POLICY_MATCH",
							ruleVersion,
						}),
					},
				}),
			},
		);
		expect(assertAllowed).toHaveBeenCalledWith(
			expect.objectContaining({ temporaryReference: reference }),
		);
		const frozen = persistApproved.mock.calls[0]![0];
		expect(frozen.inputSnapshot.temporaryReference).toEqual(reference);
		expect(frozen.moderation.inputFingerprint).toBe(
			fingerprintGenerationQuoteSecurityPayload(frozen),
		);
		expect(frozen.moderation.inputFingerprint).not.toBe(
			fingerprintGenerationQuoteSecurityPayload({
				...frozen,
				inputSnapshot: {
					...frozen.inputSnapshot,
					temporaryReference: { ...reference, checksum: "b".repeat(64) },
				},
			}),
		);
	});
	it("rejects a forged temporary reference before authorization or paid moderation", async () => {
		const assertAllowed = vi.fn(async () => undefined);
		const moderateText = vi.fn(async ({ ruleVersion }) => ({
			decision: "ALLOW" as const,
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion,
		}));
		const persistApproved = vi.fn(async (quote) => ({ id: "forged-quote", ...quote }));
		await expect(
			createQuoteForUser(
				"user_1",
				{
					...INPUT,
					temporaryReferenceToken: "forged.receipt",
				} as never,
				{
					now: () => new Date(),
					assertAllowed,
					createAdapter: () => ({ provider: "waffo", adapter: { moderateText } }),
					persistApproved,
					recordDenied: vi.fn(),
				} as never,
			),
		).rejects.toThrow("TEMPORARY_REFERENCE_INVALID");
		expect(assertAllowed).not.toHaveBeenCalled();
		expect(moderateText).not.toHaveBeenCalled();
		expect(persistApproved).not.toHaveBeenCalled();
	});
	it.each([
		["image-nano-banana-2-lite", "nano-banana-2-lite-1k", "auto"],
		["image-gpt-image-2", "gpt-image-2-1k", "1:1"],
		["image-gpt-image-2", "gpt-image-2-2k", "1:1"],
		["image-gpt-image-2", "gpt-image-2-4k", "4:5"],
		["image-seedream-5-pro", "seedream-5-pro-basic-1k", "16:9"],
		["image-seedream-5-pro", "seedream-5-pro-high-2k", "16:9"],
	] as const)("accepts the legal %s / %s selection", (productKey, skuKey, aspectRatio) => {
		expect(
			createQuoteInputSchema.safeParse({
				productKey,
				input: {
					kind: "image-to-image",
					prompt: "private prompt",
					sourceAssetId: SOURCE_ASSET_ID,
					skuKey,
					aspectRatio,
				},
			}).success,
		).toBe(true);
	});

	it("rejects retired OpenRouter products at the public quote boundary", () => {
		expect(
			createQuoteInputSchema.safeParse({
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "private prompt",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			}).success,
		).toBe(false);
	});

	it.each([
		["a SKU owned by another product", "image-nano-banana-2-lite", "gpt-image-2-4k", "1:1"],
		["a missing SKU", "image-gpt-image-2", undefined, "1:1"],
		["an unsupported aspect ratio", "image-gpt-image-2", "gpt-image-2-4k", "1:1"],
	] as const)(
		"rejects %s at the public quote boundary",
		(_label, productKey, skuKey, aspectRatio) => {
			expect(
				createQuoteInputSchema.safeParse({
					productKey,
					input: {
						kind: "image-to-image",
						prompt: "private prompt",
						sourceAssetId: SOURCE_ASSET_ID,
						...(skuKey ? { skuKey } : {}),
						aspectRatio,
					},
				}).success,
			).toBe(false);
		},
	);

	it("validates the selected parent output and runs fresh text moderation for Edit Again", async () => {
		const persistApproved = vi.fn(async (quote) => ({ id: "quote_child", ...quote }));
		const moderateText = vi.fn(async ({ ruleVersion }) => ({
			decision: "ALLOW" as const,
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion,
		}));
		const findEligibleEditParent = vi.fn(async () => ({
			editSessionId: "session-1",
			parentJobId: "job-parent",
			sourceAssetId: SOURCE_ASSET_ID,
		}));

		await expect(
			createQuoteForUser(
				"user_1",
				{ ...INPUT, parentJobId: "job-parent" } as never,
				{
					now: () => new Date("2026-08-25T00:00:00.000Z"),
					assertAllowed: vi.fn(async () => undefined),
					findEligibleEditParent,
					createAdapter: () => ({ provider: "sightengine", adapter: { moderateText } }),
					persistApproved,
					recordDenied: vi.fn(),
				} as never,
			),
		).resolves.toMatchObject({ id: "quote_child" });

		expect(findEligibleEditParent).toHaveBeenCalledWith("user_1", "job-parent", SOURCE_ASSET_ID);
		expect(moderateText).toHaveBeenCalledOnce();
		expect(persistApproved).toHaveBeenCalledWith(
			expect.objectContaining({
				inputSnapshot: {
					...INPUT.input,
					editContext: {
						kind: "CHILD",
						parentJobId: "job-parent",
						editSessionId: "session-1",
						sourceAssetId: SOURCE_ASSET_ID,
					},
				},
			}),
		);
	});

	it("creates no quote or moderation decision for an ineligible Edit Again parent", async () => {
		const createAdapter = vi.fn();
		const persistApproved = vi.fn();
		const assertAllowed = vi.fn();

		await expect(
			createQuoteForUser(
				"user_1",
				{ ...INPUT, parentJobId: "job-hidden" } as never,
				{
					now: () => new Date("2026-08-25T00:00:00.000Z"),
					assertAllowed,
					findEligibleEditParent: vi.fn(async () => null),
					createAdapter,
					persistApproved,
					recordDenied: vi.fn(),
				} as never,
			),
		).rejects.toThrow("NOT_FOUND");

		expect(assertAllowed).not.toHaveBeenCalled();
		expect(createAdapter).not.toHaveBeenCalled();
		expect(persistApproved).not.toHaveBeenCalled();
	});

	it.each(["image-to-image", "text-to-image"] as const)(
		"persists a %s quote only after one ALLOW decision",
		async (kind) => {
			const request =
				kind === "image-to-image"
					? INPUT
					: {
							...INPUT,
							input: {
								kind,
								prompt: INPUT.input.prompt,
								skuKey: INPUT.input.skuKey,
								aspectRatio: INPUT.input.aspectRatio,
							},
						};
			const persistApproved = vi.fn(async (quote) => ({ id: "quote_1", ...quote }));
			const moderateText = vi.fn(async ({ ruleVersion }) => ({
				decision: "ALLOW" as const,
				reasonCode: "NO_POLICY_MATCH",
				ruleVersion,
			}));
			const assertAllowed = vi.fn(async () => undefined);
			await expect(
				createQuoteForUser("user_1", request, {
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
					inputSnapshot:
						kind === "image-to-image"
							? { ...INPUT.input, editContext: { kind: "ROOT", rootAssetId: SOURCE_ASSET_ID } }
							: request.input,
					moderation: expect.objectContaining({
						decision: "ALLOW",
						inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
					}),
				}),
			);
		},
	);

	it("rejects a text-to-image request without a model-owned SKU before moderation or persistence", async () => {
		const createAdapter = vi.fn();
		const persistApproved = vi.fn();
		const assertAllowed = vi.fn();

		await expect(
			createQuoteForUser(
				"user_1",
				{
					productKey: "image-gpt-image-2",
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
		).rejects.toThrow("Invalid SKU for image-gpt-image-2");

		expect(assertAllowed).not.toHaveBeenCalled();
		expect(createAdapter).not.toHaveBeenCalled();
		expect(persistApproved).not.toHaveBeenCalled();
	});

	it.each(
		(["REJECT", "REVIEW", "ERROR"] as const).flatMap((decision) =>
			(["image-to-image", "text-to-image"] as const).map((kind) => ({ decision, kind })),
		),
	)(
		"records prompt-free $decision evidence for $kind and creates no quote",
		async ({ decision, kind }) => {
			const request =
				kind === "image-to-image"
					? INPUT
					: {
							...INPUT,
							input: {
								kind,
								prompt: INPUT.input.prompt,
								skuKey: INPUT.input.skuKey,
								aspectRatio: INPUT.input.aspectRatio,
							},
						};
			const persistApproved = vi.fn();
			const recordDenied = vi.fn(async () => undefined);
			await expect(
				createQuoteForUser("user_1", request, {
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
