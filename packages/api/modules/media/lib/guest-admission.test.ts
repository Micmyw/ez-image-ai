import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { submitGuestGenerationForGuest } from "./guest-admission";

describe("guest admission pre-transaction boundary", () => {
	it.each([
		["capability", { capabilityEnabled: false }, "GUEST_CAPABILITY_DISABLED", "CAPABILITY"],
		["Turnstile", { turnstileError: "TURNSTILE_INVALID" }, "TURNSTILE_INVALID", "TURNSTILE"],
		["input", { assetOverride: { byteSize: 10_485_761n } }, "GUEST_INPUT_UNAVAILABLE", "INPUT"],
		["quote", { quoteCredits: 5n }, "GUEST_PRICE_CHANGED", "QUOTE"],
		["content", { moderationDecision: "REJECT" }, "TEXT_MODERATION_REJECT", "CONTENT"],
	] as const)(
		"bounds %s denial evidence with the configured TTL",
		async (_label, options, expectedError, expectedReason) => {
			const dependencies = validDependencies(options);

			await expect(
				submitGuestGenerationForGuest(validBoundary(), validInput(), dependencies),
			).rejects.toThrow(expectedError);
			expect(dependencies.recordDenial).toHaveBeenCalledWith(
				expect.objectContaining({
					promotionPeriod: "launch-2026-08",
					reason: expectedReason,
					evidenceTtlMs: 30 * 24 * 60 * 60_000,
				}),
			);
		},
	);

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

	it("rejects a forged or paid-only tier before moderation and persistence", async () => {
		for (const productKey of ["image-quality", "video-fast"] as const) {
			const dependencies = validDependencies();
			await expect(
				submitGuestGenerationForGuest(
					validBoundary(),
					{ ...validInput(), productKey } as never,
					dependencies,
				),
			).rejects.toThrow("GUEST_PRODUCT_UNAVAILABLE");
			expect(dependencies.moderatePrompt).not.toHaveBeenCalled();
			expect(dependencies.createTransaction).not.toHaveBeenCalled();
		}
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
				sourceSessionHash: testGuestAbuseBinding(
					"independent-guest-abuse-secret",
					"launch-key-v1",
					"guest-source-session",
					"anonymous-session-1",
				),
				deviceHash: testGuestAbuseBinding(
					"independent-guest-abuse-secret",
					"launch-key-v1",
					"guest-device",
					"d4fbf8d2-945a-4f2c-8359-f179f6c734de",
				),
				ipHash: testGuestAbuseBinding(
					"independent-guest-abuse-secret",
					"launch-key-v1",
					"guest-ip",
					"203.0.113.42",
				),
				subnetHash: testGuestAbuseBinding(
					"independent-guest-abuse-secret",
					"launch-key-v1",
					"guest-subnet",
					"203.0.113.0/24",
				),
				sourceAssetId: "asset-1",
				sourceAssetChecksum: "a".repeat(64),
				turnstile: expect.objectContaining({ tokenHash: "f".repeat(64) }),
				sponsorCredits: 4n,
				abuseEvidenceTtlMs: 30 * 24 * 60 * 60_000,
				maximumRequestsPerIpPerDay: 3,
				maximumRequestsPerSubnetPerDay: 20,
				maximumGlobalRequestsPerHour: 30,
				maximumGlobalRequestsPerDay: 100,
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
		productKey: "image-fast" as const,
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
	turnstileError?: string;
}) {
	const now = new Date("2026-08-28T00:00:00.000Z");
	return {
		now: () => now,
		saasOrigin: "https://app.ezpic.test",
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
				abuseEvidenceTtlMs: 30 * 24 * 60 * 60_000,
				limits: {
					maximumActiveJobsPerGuest: 1,
					maximumAcceptedTrialsPerSession: 1,
					maximumActiveJobsPerDevice: 1,
					maximumAcceptedTrialsPerDevicePromotion: 1,
					maximumActiveJobsPerIp: 2,
					maximumRequestsPerIpPerTenMinutes: 1,
					maximumRequestsPerIpPerDay: 3,
					maximumRequestsPerSubnetPerDay: 20,
					maximumGlobalRequestsPerMinute: 3,
					maximumGlobalRequestsPerHour: 30,
					maximumGlobalRequestsPerDay: 100,
					maximumRequestsPerMinute: 3,
					maximumRequestsPerIpPerHour: 3,
					maximumGlobalQueueDepth: 25,
				},
				riskBudgetMicros: 350_000n,
				abuseHmac: {
					secretKey: "independent-guest-abuse-secret",
					keyVersion: "launch-key-v1",
				},
				turnstile: { required: false, secretKey: null },
			},
		})),
		resolveIdentity: vi.fn(() => ({ ip: "203.0.113.42", subnet: "203.0.113.0/24" })),
		verifyTurnstile: vi.fn(async () => {
			if (options?.turnstileError) throw new Error(options.turnstileError);
			return {
				tokenHash: "f".repeat(64),
				challengeTimestamp: now,
				expiresAt: new Date(now.getTime() + 5 * 60_000),
			};
		}),
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

function testGuestAbuseBinding(
	secret: string,
	keyVersion: string,
	purpose: string,
	value: string,
): string {
	return createHmac("sha256", secret)
		.update(`${keyVersion}:${purpose}:${value}`, "utf8")
		.digest("hex");
}
