import { MediaValidationError } from "@repo/storage";
import { describe, expect, it, vi } from "vitest";

import type { FinalizationClaim, FinalizationStore } from "../contracts";
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
		vi.mocked(store.claimFinalization).mockResolvedValueOnce(claim);

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
