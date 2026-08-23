/* oxlint-disable typescript/unbound-method -- assertions target dependency-injected Vitest mocks */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("@repo/database", () => ({
	claimGenerationRetryRequest: vi.fn(),
	completeGenerationRetryRequest: vi.fn(),
	createGenerationRetryQuoteCheckpoint: vi.fn(),
	createGenerationJobTransaction: vi.fn(),
	failGenerationRetryRequest: vi.fn(),
	resumeGenerationRetryRequest: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({
	db: {
		auditLog: { create: vi.fn() },
		generationJob: { findFirst: vi.fn() },
		generationQuote: { findUnique: vi.fn() },
	},
}));
vi.mock("@repo/jobs", () => ({ resolveDatabaseDispatchRoute: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: vi.fn() } }));

import { retryGenerationForUser, type RetryGenerationDependencies } from "./retry-generation";

const source = {
	id: "source-job-1",
	productKey: "image-fast",
	quote: {
		inputSnapshot: { kind: "text-to-image", prompt: "  A current prompt  " },
		moderationDecision: "ALLOW",
		moderationProvider: "legacy-provider",
		moderationRuleVersion: "stale-rule",
		moderationReasonCode: "STALE_ALLOW",
	},
	assets: [{ assetId: "asset-1", assetChecksum: "1".repeat(64) }],
};

const checkpointQuote = {
	id: "quote-1",
	ownerType: "USER" as const,
	ownerId: "user-1",
	submittedByUserId: "user-1",
	productKey: "image-fast",
	catalogVersion: "2026-08-13.1",
	pricingVersion: "2026-08-13.1",
	credits: 4n,
	costMicros: 3_000n,
	inputSnapshot: { kind: "text-to-image", prompt: "A current prompt" },
	pricingSnapshot: { credits: 4, maximumJobCostMicros: 5_000_000 },
	expiresAt: new Date("2026-08-23T00:10:00.000Z"),
	moderationDecision: "ALLOW",
	moderationProvider: "test",
	moderationRuleVersion: "text-safety-2026-08-14.1",
	moderationReasonCode: "TEST_ALLOW",
	inputFingerprint: "f".repeat(64),
};

const retryOperation = {
	sourceJobId: "source-job-1",
	productKey: "image-fast",
	normalizedInput: { kind: "text-to-image" as const, prompt: "A current prompt" },
	inputAssets: [{ assetId: "asset-1", assetChecksum: "1".repeat(64) }],
	catalogVersion: "2026-08-13.1",
	pricingVersion: "2026-08-13.1",
	credits: "4",
	costMicros: "3000",
	pricingSnapshot: { credits: 4, maximumJobCostMicros: 5_000_000 },
	moderationProvider: "test",
	moderationRuleVersion: "text-safety-2026-08-14.1",
	assetModerationRuleVersion: "media-safety-2026-08-23.1",
	assetModerationPolicyVersion: "media-policy-2026-08-23.1",
};

function dependencies(
	overrides: Partial<RetryGenerationDependencies> = {},
): RetryGenerationDependencies {
	return {
		now: () => new Date("2026-08-23T00:00:00.000Z"),
		resumeRequest: vi.fn(async () => null),
		findSource: vi.fn(async () => source),
		assertAllowed: vi.fn(async () => undefined),
		claimRequest: vi.fn(async () => ({
			outcome: "CLAIMED" as const,
			requestId: "request-1",
			leaseToken: "lease-1",
			operation: retryOperation,
		})),
		createAdapter: vi.fn(() => ({
			provider: "test" as const,
			adapter: {
				moderateText: vi.fn(async ({ ruleVersion }: { text: string; ruleVersion: string }) => ({
					decision: "ALLOW" as const,
					reasonCode: "TEST_ALLOW",
					ruleVersion,
				})),
			},
		})),
		persistApproved: vi.fn(async () => ({ id: "quote-1" })),
		findCheckpointQuote: vi.fn(async () => checkpointQuote),
		createJob: vi.fn(async () => ({
			job: {
				id: "result-job-1",
				status: "RESERVED" as const,
				version: 0,
				creditsReserved: 4n,
			},
			reservation: { id: "reservation-1", amount: 4n, status: "ACTIVE" as const },
			replayed: false,
		})),
		completeRequest: vi.fn(async () => true),
		failRequest: vi.fn(async () => true),
		getJob: vi.fn(async () => ({ id: "result-job-1", status: "PROVIDER_RUNNING" })),
		dispatch: vi.fn(async () => undefined),
		...overrides,
	};
}

describe("retryGenerationForUser", () => {
	it("replays a completed retry before resolving a retired product or current policy", async () => {
		const moderateText = vi.fn();
		const deps = dependencies({
			findSource: vi.fn(async () => {
				throw new Error("current product lookup must not run for a terminal replay");
			}),
			resumeRequest: vi.fn(async () => ({
				outcome: "SUCCEEDED" as const,
				requestId: "request-1",
				resultJobId: "result-job-1",
			})),
			createAdapter: () => ({
				provider: "test",
				adapter: { moderateText },
			}),
		} as never);

		await expect(
			retryGenerationForUser(
				"user-1",
				{ jobId: "source-job-1", idempotencyKey: "retry-operation-1" },
				deps,
			),
		).resolves.toEqual({ jobId: "result-job-1", status: "PROVIDER_RUNNING", replayed: true });
		expect(deps.findSource).not.toHaveBeenCalled();
		expect(deps.claimRequest).not.toHaveBeenCalled();
		expect(moderateText).not.toHaveBeenCalled();
		expect(deps.createJob).not.toHaveBeenCalled();
	});

	it("ignores stale source evidence and moderates the current prompt and policy once", async () => {
		const moderateText = vi.fn(async ({ ruleVersion }: { text: string; ruleVersion: string }) => ({
			decision: "ALLOW" as const,
			reasonCode: "TEST_ALLOW",
			ruleVersion,
		}));
		const deps = dependencies({
			createAdapter: () => ({ provider: "test", adapter: { moderateText } }),
		});

		await expect(
			retryGenerationForUser(
				"user-1",
				{ jobId: "source-job-1", idempotencyKey: "retry-operation-1" },
				deps,
			),
		).resolves.toEqual({ jobId: "result-job-1", status: "RESERVED", replayed: false });
		expect(moderateText).toHaveBeenCalledTimes(1);
		expect(moderateText).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "A current prompt",
				ruleVersion: expect.stringMatching(/^text-safety-/),
			}),
		);
		expect(deps.claimRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				operation: {
					assetModerationPolicyVersion: expect.any(String),
					assetModerationRuleVersion: expect.any(String),
					catalogVersion: "2026-08-13.1",
					costMicros: "3000",
					credits: "4",
					inputAssets: [{ assetChecksum: "1".repeat(64), assetId: "asset-1" }],
					moderationProvider: "test",
					moderationRuleVersion: expect.stringMatching(/^text-safety-/),
					normalizedInput: {
						kind: "text-to-image",
						prompt: "A current prompt",
					},
					pricingSnapshot: { credits: 4, maximumJobCostMicros: 5_000_000 },
					pricingVersion: "2026-08-13.1",
					productKey: "image-fast",
					sourceJobId: "source-job-1",
				},
			}),
		);
		expect(deps.persistApproved).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "request-1",
				leaseToken: "lease-1",
			}),
		);
		expect(deps.createJob).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedInputAssets: [{ assetId: "asset-1", assetChecksum: "1".repeat(64) }],
			}),
		);
		expect(deps.completeRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "request-1",
				leaseToken: "lease-1",
				quoteId: "quote-1",
				resultJobId: "result-job-1",
			}),
		);
	});

	it("resumes a durable approved quote checkpoint without calling moderation again", async () => {
		const deps = dependencies({
			findSource: vi.fn(async () => {
				throw new Error("current source and catalog must not run for a durable resume");
			}),
			resumeRequest: vi.fn(async () => ({
				outcome: "CLAIMED" as const,
				requestId: "request-1",
				leaseToken: "lease-2",
				operation: retryOperation,
				quoteId: "quote-1",
			})),
			findCheckpointQuote: vi.fn(async () => checkpointQuote),
			createAdapter: vi.fn(() => {
				throw new Error("current moderation provider must not run for a durable checkpoint");
			}),
		} as never);

		await expect(
			retryGenerationForUser(
				"user-1",
				{ jobId: "source-job-1", idempotencyKey: "retry-operation-1" },
				deps,
			),
		).resolves.toEqual({ jobId: "result-job-1", status: "RESERVED", replayed: false });
		expect(deps.findSource).not.toHaveBeenCalled();
		expect(deps.claimRequest).not.toHaveBeenCalled();
		expect(deps.persistApproved).not.toHaveBeenCalled();
		expect(deps.createJob).toHaveBeenCalledWith(expect.objectContaining({ quoteId: "quote-1" }));
	});

	it("does not call moderation when the same request is already in progress", async () => {
		const deps = dependencies({
			claimRequest: vi.fn(async () => ({
				outcome: "IN_PROGRESS" as const,
				requestId: "request-1",
			})),
		});

		await expect(
			retryGenerationForUser(
				"user-1",
				{ jobId: "source-job-1", idempotencyKey: "retry-operation-1" },
				deps,
			),
		).rejects.toThrow("GENERATION_RETRY_IN_PROGRESS");
		expect(deps.createJob).not.toHaveBeenCalled();
	});

	it("replays the stored terminal error code without changing its HTTP semantics", async () => {
		const deps = dependencies({
			resumeRequest: vi.fn(async () => ({
				outcome: "FAILED" as const,
				requestId: "request-1",
				errorCode: "CONTENT_NOT_ALLOWED",
			})),
		} as never);

		await expect(
			retryGenerationForUser(
				"user-1",
				{ jobId: "source-job-1", idempotencyKey: "retry-operation-1" },
				deps,
			),
		).rejects.toThrow("CONTENT_NOT_ALLOWED");
		expect(deps.findSource).not.toHaveBeenCalled();
		expect(deps.createAdapter).not.toHaveBeenCalled();
		expect(deps.createJob).not.toHaveBeenCalled();
	});

	it("records a safe terminal failure when current moderation rejects the prompt", async () => {
		const deps = dependencies({
			createAdapter: vi.fn(() => ({
				provider: "test" as const,
				adapter: {
					moderateText: vi.fn(async ({ ruleVersion }: { text: string; ruleVersion: string }) => ({
						decision: "REJECT" as const,
						reasonCode: "TEST_REJECT",
						ruleVersion,
					})),
				},
			})),
		});

		await expect(
			retryGenerationForUser(
				"user-1",
				{ jobId: "source-job-1", idempotencyKey: "retry-operation-1" },
				deps,
			),
		).rejects.toThrow("TEXT_MODERATION_REJECT");
		expect(deps.failRequest).toHaveBeenCalledWith({
			requestId: "request-1",
			leaseToken: "lease-1",
			errorCode: "CONTENT_NOT_ALLOWED",
		});
		expect(deps.createJob).not.toHaveBeenCalled();
	});

	it("leaves a post-job claim recoverable when request completion loses its lease", async () => {
		const deps = dependencies({
			completeRequest: vi.fn(async () => {
				throw new Error("GENERATION_RETRY_CLAIM_LOST");
			}),
		});

		await expect(
			retryGenerationForUser(
				"user-1",
				{ jobId: "source-job-1", idempotencyKey: "retry-operation-1" },
				deps,
			),
		).rejects.toThrow("GENERATION_RETRY_CLAIM_LOST");
		expect(deps.createJob).toHaveBeenCalledOnce();
		expect(deps.failRequest).not.toHaveBeenCalled();
	});

	it("keeps an idempotency race recoverable for the durable job lookup", async () => {
		const deps = dependencies({
			createJob: vi.fn(async () => {
				throw new Error("IDEMPOTENCY_CONFLICT");
			}),
		});

		await expect(
			retryGenerationForUser(
				"user-1",
				{ jobId: "source-job-1", idempotencyKey: "retry-operation-1" },
				deps,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		expect(deps.failRequest).not.toHaveBeenCalled();
	});

	it("keeps a create-job commit acknowledgement loss recoverable", async () => {
		const deps = dependencies({
			createJob: vi.fn(async () => {
				throw new Error("connection terminated after COMMIT");
			}),
		});

		await expect(
			retryGenerationForUser(
				"user-1",
				{ jobId: "source-job-1", idempotencyKey: "retry-operation-1" },
				deps,
			),
		).rejects.toThrow("connection terminated after COMMIT");
		expect(deps.failRequest).not.toHaveBeenCalled();
	});
});
