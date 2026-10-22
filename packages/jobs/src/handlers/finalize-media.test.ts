import { MediaValidationError } from "@repo/storage";
import { describe, expect, it, vi } from "vitest";

import type { FinalizationClaim, FinalizationStore } from "../contracts";
import {
	GenerationTransferRequiresHeavyError,
	OutputTransferClaimConflictError,
} from "../contracts";
import { finalizeMedia } from "./finalize-media";

const CLAIM: FinalizationClaim = {
	jobId: "job_1",
	ownerId: "user_1",
	mediaKind: "image",
	candidates: [
		{
			key: "candidate-invalid",
			output: {
				kind: "remote-url",
				url: "https://cdn.example/invalid",
				trust: "untrusted-transfer-candidate",
			},
		},
		{
			key: "candidate-valid",
			output: {
				kind: "remote-url",
				url: "https://cdn.example/valid",
				trust: "untrusted-transfer-candidate",
			},
		},
	],
};

function createStore(): FinalizationStore & {
	claimFinalization: ReturnType<typeof vi.fn>;
	findPersistedCandidate: ReturnType<typeof vi.fn>;
	recordFinalization: ReturnType<typeof vi.fn>;
	recordFinalizationRetry: ReturnType<typeof vi.fn>;
} {
	return {
		claimFinalization: vi.fn(async () => CLAIM),
		findPersistedCandidate: vi.fn(async () => null),
		recordFinalization: vi.fn(async () => undefined),
		recordFinalizationRetry: vi.fn(async () => ({
			outcome: "RETRY_SCHEDULED" as const,
			retryCount: 1,
		})),
	};
}

describe("finalizeMedia terminal transfer policy", () => {
	it("returns the committed retry event and preserves independent pending output reviews", async () => {
		const store = createStore();
		const retryEvent = { id: "committed-transfer-retry", availableAt: 1_800_000_120_000 };
		store.recordFinalizationRetry.mockResolvedValueOnce({
			outcome: "RETRY_SCHEDULED",
			retryCount: 1,
			retryEvent,
		});
		await expect(
			finalizeMedia(
				{ jobId: CLAIM.jobId, version: 0 },
				{
					store,
					persistCandidate: async (_claim, candidate) => {
						if (candidate.key === "candidate-invalid") throw new Error("remote timeout");
						return {
							assetId: "pending-output",
							approved: false,
							moderationPending: true,
							outputReviewEventId: "committed-output-review",
						};
					},
				},
			),
		).resolves.toEqual({
			outcome: "RETRY_SCHEDULED",
			readyOutputs: 0,
			retryEvent,
			outputReviewEventIds: ["committed-output-review"],
		});
		expect(store.recordFinalization).not.toHaveBeenCalled();
	});

	it("hands the same task back to heavy without finalization retry or settlement", async () => {
		const store = createStore();
		const reroute = new GenerationTransferRequiresHeavyError();
		await expect(
			finalizeMedia(
				{ jobId: CLAIM.jobId, version: 0 },
				{
					store,
					persistCandidate: async () => {
						throw reroute;
					},
				},
			),
		).rejects.toBe(reroute);
		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
		expect(store.recordFinalization).not.toHaveBeenCalled();
	});
	it("keeps a persisted sibling when a later candidate's claim conflict retries the same task", async () => {
		const store = createStore();
		const persisted = new Map<string, { assetId: string; approved: boolean }>();
		const conflict = new OutputTransferClaimConflictError({ code: "P2034" });
		let secondClaimFailed = false;
		store.findPersistedCandidate.mockImplementation(
			async (_jobId: string, key: string) => persisted.get(key) ?? null,
		);
		const persistCandidate = vi.fn(
			async (_claim: FinalizationClaim, candidate: { key: string }) => {
				if (candidate.key === CLAIM.candidates[1]!.key && !secondClaimFailed) {
					secondClaimFailed = true;
					throw conflict;
				}
				const result = { assetId: `asset:${candidate.key}`, approved: true };
				persisted.set(candidate.key, result);
				return result;
			},
		);
		const dependencies = { store, persistCandidate };
		await expect(finalizeMedia({ jobId: CLAIM.jobId, version: 0 }, dependencies)).rejects.toBe(
			conflict,
		);
		expect(persisted.size).toBe(1);
		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
		expect(store.recordFinalization).not.toHaveBeenCalled();
		await expect(finalizeMedia({ jobId: CLAIM.jobId, version: 0 }, dependencies)).resolves.toEqual({
			outcome: "FINALIZED",
			readyOutputs: 2,
		});
		expect(persistCandidate.mock.calls.map(([, candidate]) => candidate.key)).toEqual([
			CLAIM.candidates[0]!.key,
			CLAIM.candidates[1]!.key,
			CLAIM.candidates[1]!.key,
		]);
		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
		expect(store.recordFinalization).toHaveBeenCalledOnce();
	});
	it("returns the committed first-review event without settling or spending a technical retry", async () => {
		const store = createStore();
		const claim = { ...CLAIM, candidates: CLAIM.candidates.slice(0, 1) };
		store.claimFinalization.mockResolvedValue(claim);
		const persistCandidate = vi.fn(async () => ({
			assetId: "private-output",
			approved: false,
			moderationPending: true,
			outputReviewEventId: "committed-first-review",
		}));
		await expect(
			finalizeMedia({ jobId: claim.jobId, version: 0 }, { store, persistCandidate }),
		).resolves.toEqual({
			outcome: "WAITING_MODERATION",
			readyOutputs: 0,
			outputReviewEventIds: ["committed-first-review"],
		});
		expect(persistCandidate).toHaveBeenCalledWith(claim, claim.candidates[0], {
			persistedCandidateChecked: true,
		});
		expect(store.findPersistedCandidate).toHaveBeenCalledOnce();
		expect(store.recordFinalization).not.toHaveBeenCalled();
		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
	});
	it("persists a deterministic validation failure and still settles valid sibling outputs", async () => {
		const store = createStore();
		const persistCandidate = vi.fn(
			async (_claim: FinalizationClaim, candidate: { key: string }) => {
				if (candidate.key === "candidate-invalid") {
					throw new MediaValidationError(
						"OUTPUT_MEDIA_TYPE_MISMATCH",
						"Provider output signature does not match its declared media type",
					);
				}
				return { assetId: "asset_valid", approved: true };
			},
		);

		await expect(
			finalizeMedia(
				{ jobId: CLAIM.jobId, version: 0 },
				{ store, persistCandidate: persistCandidate as never },
			),
		).resolves.toEqual({ outcome: "FINALIZED", readyOutputs: 1 });

		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
		expect(store.recordFinalization).toHaveBeenCalledWith(
			CLAIM,
			[{ assetId: "asset_valid", approved: true, candidateKey: "candidate-valid" }],
			expect.objectContaining({
				stage: "TRANSFER",
				code: "OUTPUT_MEDIA_TYPE_MISMATCH",
				retryable: false,
			}),
		);
	});

	it("schedules a retry for a transient transfer failure below the store budget", async () => {
		const store = createStore();
		const persistCandidate = vi.fn(async () => {
			throw new Error("S3 unavailable");
		});

		await expect(
			finalizeMedia(
				{ jobId: CLAIM.jobId, version: 0 },
				{ store, persistCandidate: persistCandidate as never },
			),
		).resolves.toEqual({ outcome: "RETRY_SCHEDULED", readyOutputs: 0 });

		expect(store.recordFinalizationRetry).toHaveBeenCalledWith(
			CLAIM,
			expect.objectContaining({
				stage: "TRANSFER",
				code: "FINALIZATION_RETRYABLE",
				retryable: true,
			}),
			[],
		);
		expect(store.recordFinalization).not.toHaveBeenCalled();
	});

	it("records an oversized inline candidate as a deterministic transfer failure", async () => {
		const store = createStore();
		const claim: FinalizationClaim = {
			...CLAIM,
			candidates: [
				{
					key: "candidate-oversized-inline",
					output: {
						kind: "inline-base64",
						mimeType: "image/png",
						data: "A".repeat(64),
						trust: "untrusted-transfer-candidate",
					},
				},
			],
		};
		store.claimFinalization.mockResolvedValueOnce(claim);

		await expect(
			finalizeMedia(
				{ jobId: CLAIM.jobId, version: 0 },
				{ store, persistCandidate: vi.fn() as never, maxInlineImageBytes: 1 },
			),
		).resolves.toEqual({ outcome: "FINALIZED", readyOutputs: 0 });

		expect(store.recordFinalization).toHaveBeenCalledWith(
			claim,
			[],
			expect.objectContaining({
				stage: "TRANSFER",
				code: "OUTPUT_MEDIA_SIZE_EXCEEDED",
				retryable: false,
			}),
		);
	});

	it("returns a settlement-ready terminal outcome when the transient retry budget is exhausted", async () => {
		const store = createStore();
		store.recordFinalizationRetry.mockResolvedValueOnce({ outcome: "TERMINAL", retryCount: 5 });
		const persistCandidate = vi.fn(
			async (_claim: FinalizationClaim, candidate: { key: string }) => {
				if (candidate.key === "candidate-invalid")
					return { assetId: "asset_valid", approved: true };
				throw new Error("remote timeout");
			},
		);

		await expect(
			finalizeMedia(
				{ jobId: CLAIM.jobId, version: 0 },
				{ store, persistCandidate: persistCandidate as never },
			),
		).resolves.toEqual({ outcome: "FINALIZED", readyOutputs: 1 });

		expect(store.recordFinalizationRetry).toHaveBeenCalledWith(
			CLAIM,
			expect.objectContaining({ retryable: true }),
			[{ assetId: "asset_valid", approved: true, candidateKey: "candidate-invalid" }],
		);
		expect(store.recordFinalization).not.toHaveBeenCalled();
	});
});
