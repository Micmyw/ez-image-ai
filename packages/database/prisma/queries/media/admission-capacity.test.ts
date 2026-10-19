import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database connection");
	},
}));
vi.mock("./credits", () => ({
	createCreditGrant: vi.fn(),
	reserveCreditsInTransaction: vi.fn(),
	releaseCreditsInTransaction: vi.fn(),
	settleCreditsInTransaction: vi.fn(),
}));

import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import { createVideoJobRecord } from "./video-v1";

afterEach(() => vi.unstubAllEnvs());

describe("funded generation admission without account concurrency caps", () => {
	it.each([0, 1, 3, 6, 10, 32, 80])(
		"allows another image request with %i unfinished owner jobs",
		async (ownerActive) => {
			vi.stubEnv("VIDEO_V1_PROVIDER_CONCURRENCY", "1");
			const nextBoundary = new Error("STORAGE_CHECK_REACHED");
			const quote = {
				id: "quote-1",
				ownerType: "USER" as const,
				ownerId: "owner",
				submittedByUserId: "owner",
				productKey: "image-fast",
				catalogVersion: "catalog",
				pricingVersion: "pricing",
				credits: 5n,
				costMicros: 100n,
				inputSnapshot: { kind: "text-to-image", prompt: "approved" },
				pricingSnapshot: {},
				expiresAt: new Date("2099-01-01"),
				moderationDecision: "ALLOW",
				moderationProvider: "test",
				moderationRuleVersion: "rule",
				moderationReasonCode: "ALLOW",
			};
			const tx = {
				$executeRaw: vi.fn().mockResolvedValue(1),
				$queryRaw: vi.fn().mockResolvedValue([{ now: new Date() }]),
				generationQuote: {
					findUnique: vi.fn().mockResolvedValue({
						...quote,
						inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote),
					}),
				},
				generationJob: {
					findUnique: vi.fn().mockResolvedValue(null),
					// Six other owners' queued/uncertain jobs must not consume this owner's plan slot.
					count: vi.fn(async ({ where }: { where: { ownerId?: string } }) =>
						where.ownerId === "owner" ? ownerActive : 6,
					),
				},
				subscription: { findMany: vi.fn(async () => []) },
				billingPeriod: { fields: { paidAmount: "paidAmount" } },
				storageUsageReservation: { aggregate: vi.fn().mockRejectedValue(nextBoundary) },
			};
			const client = { $transaction: vi.fn(async (operation) => operation(tx)) };
			const attempt = createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId: "owner",
					submittedByUserId: "owner",
					quoteId: "quote-1",
					idempotencyKey: "request-1",
					inputAssetIds: [],
					expectedModerationRuleVersion: "rule",
					maximumConcurrentJobs: 1,
					maximumStorageBytes: 1000n,
				},
				client as never,
			);
			await expect(attempt).rejects.toBe(nextBoundary);
			expect(tx.generationJob.count).not.toHaveBeenCalled();
		},
	);

	it.each([undefined, 0, 1])(
		"ignores retired video admission capacities %s during an accepted replay",
		async (retiredLimit) => {
			const request = {
				mode: "text-to-video",
				prompt: "approved",
				duration: 5,
				sound: false,
				aspectRatio: "16:9",
			} as const;
			const tx = {
				$executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
					if (sql.join("").includes("media:provider-capacity:kie"))
						throw new Error("UNEXPECTED_SHARED_ADMISSION_LOCK");
					return 1;
				}),
				generationQuote: { findFirst: vi.fn().mockResolvedValue(null) },
				generationJob: {
					findUnique: vi.fn().mockResolvedValue({
						id: "accepted-job",
						executionEngine: "video-workflow-v1",
						inputSnapshot: request,
						videoExecution: {},
						reservation: {},
					}),
				},
			};
			const client = { $transaction: vi.fn(async (operation) => operation(tx)) };
			await expect(
				createVideoJobRecord(
					{
						ownerId: "owner",
						quoteId: "accepted-quote",
						idempotencyKey: "request-1",
						request,
						limits: {
							ownerConcurrency: retiredLimit,
							globalConcurrency: retiredLimit,
							providerConcurrency: retiredLimit,
							maximumStorageBytes: 1000n,
							maximumInputBytes: 1000,
						},
					} as never,
					client as never,
				),
			).resolves.toEqual({ jobId: "accepted-job", replayed: true });
		},
	);
});
