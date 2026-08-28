import { describe, expect, it, vi } from "vitest";

import { submitGuestGenerationForGuest } from "./guest-admission";

describe("guest admission pre-transaction boundary", () => {
	it.each([
		["oversized source", { byteSize: 10_485_761n }, "GUEST_INPUT_UNAVAILABLE", 4n, "INPUT"],
		[
			"stale source",
			{ verificationValidUntil: new Date("2026-08-27T23:59:59.999Z") },
			"GUEST_INPUT_UNAVAILABLE",
			4n,
			"INPUT",
		],
		["wrong product price", {}, "GUEST_PRICE_CHANGED", 5n, "QUOTE"],
	] as const)(
		"creates no business graph for %s",
		async (_label, assetOverride, errorCode, quoteCredits, denialReason) => {
			const dependencies = validDependencies({ assetOverride, quoteCredits });

			await expect(
				submitGuestGenerationForGuest(validBoundary(), validInput(), dependencies),
			).rejects.toThrow(errorCode);
			expect(dependencies.createTransaction).not.toHaveBeenCalled();
			expect(dependencies.recordDenial).toHaveBeenCalledWith(
				expect.objectContaining({
					promotionPeriod: "launch-2026-08",
					reason: denialReason,
				}),
			);
		},
	);

	it.each(["REJECT", "REVIEW", "ERROR"] as const)(
		"persists nothing when prompt moderation returns %s",
		async (decision) => {
			const dependencies = validDependencies({ moderationDecision: decision });

			await expect(
				submitGuestGenerationForGuest(validBoundary(), validInput(), dependencies),
			).rejects.toThrow(`TEXT_MODERATION_${decision}`);
			expect(dependencies.createTransaction).not.toHaveBeenCalled();
			expect(dependencies.recordDenial).toHaveBeenCalledWith(
				expect.objectContaining({ reason: "CONTENT" }),
			);
		},
	);

	it("records bounded capability and durable transaction denial reasons", async () => {
		const disabled = validDependencies({ capabilityEnabled: false });
		await expect(
			submitGuestGenerationForGuest(validBoundary(), validInput(), disabled),
		).rejects.toThrow("GUEST_CAPABILITY_DISABLED");
		expect(disabled.recordDenial).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "CAPABILITY" }),
		);

		const queueDenied = validDependencies({ createError: "GUEST_QUEUE_CAPACITY" });
		await expect(
			submitGuestGenerationForGuest(validBoundary(), validInput(), queueDenied),
		).rejects.toThrow("GUEST_QUEUE_CAPACITY");
		expect(queueDenied.recordDenial).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "QUEUE_CAPACITY" }),
		);
	});

	it("requires an exact origin, attributed client, and bounded random device before Turnstile", async () => {
		const dependencies = validDependencies();

		await expect(
			submitGuestGenerationForGuest(
				{ ...validBoundary(), origin: "https://evil.test" },
				validInput(),
				dependencies,
			),
		).rejects.toThrow("FORBIDDEN_ORIGIN");
		await expect(
			submitGuestGenerationForGuest(
				validBoundary(),
				{ ...validInput(), deviceId: "predictable" },
				dependencies,
			),
		).rejects.toThrow("GUEST_DEVICE_INVALID");
		expect(dependencies.verifyTurnstile).not.toHaveBeenCalled();
		expect(dependencies.createTransaction).not.toHaveBeenCalled();
	});

	it("passes only the fixed Standard quote and verified source into the atomic transaction", async () => {
		const dependencies = validDependencies();

		await expect(
			submitGuestGenerationForGuest(validBoundary(), validInput(), dependencies),
		).resolves.toMatchObject({ jobId: "job-1", stage: "WAITING" });
		expect(dependencies.recordDenial).not.toHaveBeenCalled();
		expect(dependencies.verifyTurnstile).toHaveBeenCalledOnce();
		expect(dependencies.createTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerId: "guest-1",
				promotionPeriod: "launch-2026-08",
				capabilityVersion: "guest-v7",
				sourceAssetId: "asset-1",
				sourceAssetChecksum: "a".repeat(64),
				turnstile: expect.objectContaining({ tokenHash: "f".repeat(64) }),
				sponsorCredits: 4n,
				quote: expect.objectContaining({
					productKey: "image-fast",
					credits: 4n,
					moderation: expect.objectContaining({ decision: "ALLOW" }),
				}),
			}),
		);
	});
});

function validBoundary() {
	return {
		ownerId: "guest-1",
		sessionId: "anonymous-session-1",
		origin: "https://app.ezpic.test",
		headers: new Headers({ "x-vercel-forwarded-for": "203.0.113.42" }),
	};
}

function validInput() {
	return {
		capabilityVersion: "guest-v7",
		sourceAssetId: "asset-1",
		prompt: "Make the sky violet",
		idempotencyKey: "guest-submit-0001",
		deviceId: "d4fbf8d2-945a-4f2c-8359-f179f6c734de",
		turnstileToken: "turnstile-token",
	};
}

function validDependencies(options?: {
	assetOverride?: Record<string, unknown>;
	capabilityEnabled?: boolean;
	createError?: string;
	moderationDecision?: "ALLOW" | "REJECT" | "REVIEW" | "ERROR";
	quoteCredits?: bigint;
}) {
	const now = new Date("2026-08-28T00:00:00.000Z");
	return {
		now: () => now,
		saasOrigin: "https://app.ezpic.test",
		abuseSecret: "independent-guest-abuse-secret",
		loadCapability: vi.fn(async () => ({
			snapshot: { version: "guest-v7" },
			config: {
				enabled: options?.capabilityEnabled ?? true,
				promotionPeriod: "launch-2026-08",
				productKey: "image-fast",
				sponsorCredits: 4n,
				maximumBytes: 10 * 1024 * 1024,
				mimeTypes: ["image/jpeg", "image/png", "image/webp"],
				retentionMs: 24 * 60 * 60_000,
				queueTtlMs: 15 * 60_000,
				limits: {
					maximumActiveJobsPerGuest: 1,
					maximumRequestsPerMinute: 3,
					maximumRequestsPerIpPerHour: 12,
					maximumGlobalQueueDepth: 100,
				},
				riskBudgetMicros: 350_000n,
				turnstile: { required: false, secretKey: null },
			},
		})),
		resolveIdentity: vi.fn(() => ({ ip: "203.0.113.42", subnet: "203.0.113.0/24" })),
		verifyTurnstile: vi.fn(async () => ({
			tokenHash: "f".repeat(64),
			challengeTimestamp: now,
			expiresAt: new Date(now.getTime() + 5 * 60_000),
		})),
		loadSourceAsset: vi.fn(async () => ({
			id: "asset-1",
			ownerType: "USER",
			ownerId: "guest-1",
			kind: "INPUT",
			status: "READY",
			retentionClass: "GUEST_TRIAL",
			deleteAfter: new Date("2026-08-29T00:00:00.000Z"),
			mimeType: "image/png",
			byteSize: 1024n,
			checksum: "a".repeat(64),
			verificationValidUntil: new Date("2026-08-29T00:00:00.000Z"),
			...options?.assetOverride,
		})),
		loadSourceBootstrap: vi.fn(async () => ({
			id: "bootstrap-1",
			claimedDraftId: "draft-1",
			sourceAssetId: "asset-1",
		})),
		buildQuote: vi.fn(() => ({
			productKey: "image-fast",
			catalogVersion: "catalog-v1",
			pricingVersion: "pricing-v1",
			credits: options?.quoteCredits ?? 4n,
			costMicros: 3500n,
			pricingSnapshot: {},
		})),
		moderatePrompt: vi.fn(async () => ({
			decision: options?.moderationDecision ?? "ALLOW",
			provider: "test" as const,
			ruleVersion: "text-safety-2026-08-14.1",
			reasonCode: options?.moderationDecision ?? "ALLOW",
		})),
		createTransaction: vi.fn(async () => {
			if (options?.createError) throw new Error(options.createError);
			return {
				jobId: "job-1",
				trialId: "trial-1",
				stage: "WAITING" as const,
				projectedDispatchAt: new Date("2026-08-28T00:00:00.000Z"),
				estimateExpiresAt: new Date("2026-08-28T00:01:00.000Z"),
				resultExpiresAt: new Date("2026-08-29T00:00:00.000Z"),
				resultAssetId: null,
				watermarked: false,
				trialConsumed: false,
				linkReady: true,
			};
		}),
		recordDenial: vi.fn(async () => undefined),
	};
}
