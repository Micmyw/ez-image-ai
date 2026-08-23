import type { NormalizedResult } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

import { dispatchGeneration } from "./dispatch-generation";
import { finalizeMedia } from "./finalize-media";
import { processProviderEvent } from "./process-provider-event";
import { settleGeneration } from "./settle-generation";

describe("reliable generation orchestration", () => {
	it("submits, finalizes and settles idempotently", async () => {
		const submit = vi.fn(async () => ({
			providerTaskId: "provider-task-1",
			status: "QUEUED" as const,
			acceptance: "CERTAIN" as const,
			idempotency: { key: "attempt-1", replayed: false },
			reconciliation: { submissionToken: "attempt-1" },
		}));
		const store = createInMemoryStore();
		const provider = {
			provider: "replicate" as const,
			submit,
			retrieve: vi.fn(),
			normalizeResult: vi.fn(async () => ({
				outputs: [
					{
						kind: "remote-url" as const,
						url: "https://cdn.example/candidate-1.png",
						trust: "untrusted-transfer-candidate" as const,
					},
				],
				progress: 100,
				providerCostMicros: 1_000,
				failure: null,
				retryable: false,
				providerCharged: true,
			})),
		};

		await dispatchGeneration(
			{ jobId: "job-1", version: 0 },
			{ store, getProvider: () => provider },
		);
		await dispatchGeneration(
			{ jobId: "job-1", version: 0 },
			{ store, getProvider: () => provider },
		);
		expect(submit).toHaveBeenCalledTimes(1);

		await processProviderEvent(
			{ providerWebhookEventId: "event-1" },
			{ store, getProvider: () => provider },
		);
		await finalizeMedia(
			{ jobId: "job-1", version: 2 },
			{
				store,
				persistCandidate: async () => ({ assetId: "asset-1", approved: true }),
			},
		);
		await settleGeneration({ jobId: "job-1", version: 3 }, { store });
		await settleGeneration({ jobId: "job-1", version: 3 }, { store });

		expect(store.state.status).toBe("SUCCEEDED");
		expect(store.state.assets).toEqual(["asset-1"]);
		expect(store.state.settlementCount).toBe(1);
	});
});

function createInMemoryStore() {
	const state = {
		status: "RESERVED",
		attemptId: null as string | null,
		providerTaskId: null as string | null,
		candidates: [] as Array<{
			key: string;
			output: {
				kind: "remote-url";
				url: string;
				trust: "untrusted-transfer-candidate";
			};
		}>,
		assets: [] as string[],
		settlementCount: 0,
	};
	return {
		state,
		async claimDispatch() {
			if (state.status !== "RESERVED") return null;
			state.status = "SUBMITTING";
			state.attemptId = "attempt-1";
			return {
				attemptId: "attempt-1",
				provider: "replicate" as const,
				providerModelId: "model-1",
				mediaKind: "image" as const,
				queueKey: "replicate:model-1",
				input: { kind: "text-to-image" as const, prompt: "hello" },
			};
		},
		async recordSubmission(_attemptId: string, submission: { providerTaskId?: string }) {
			state.providerTaskId = submission.providerTaskId ?? null;
			state.status = "PROVIDER_PENDING";
		},
		async recordSynchronousCompletion() {},
		async recordUncertainSubmission() {},
		async recordRejectedSubmission() {},
		async markUncertainForManualReconciliation() {},
		async claimProviderEvent() {
			if (state.status !== "PROVIDER_PENDING") return null;
			return {
				eventId: "event-1",
				attemptId: "attempt-1",
				provider: "replicate" as const,
				receivedAt: new Date(),
				processingToken: "test-lease",
				snapshot: {
					providerTaskId: "provider-task-1",
					status: "SUCCEEDED" as const,
					raw: {},
				},
			};
		},
		async recordProviderProgress(_claim: unknown, result: NormalizedResult) {
			state.status = "FINALIZING";
			state.candidates = result.outputs
				.filter((output) => output.kind === "remote-url")
				.map((output, index) => ({
					key: `candidate-${index + 1}`,
					output,
				}));
		},
		async recordProviderEventFailure() {},
		async claimFinalization() {
			if (state.status !== "FINALIZING") return null;
			return {
				jobId: "job-1",
				ownerId: "user-1",
				mediaKind: "image" as const,
				candidates: state.candidates,
			};
		},
		async findPersistedCandidate() {
			return null;
		},
		async recordFinalization(
			_claim: unknown,
			results: Array<{ assetId: string; approved: boolean }>,
		) {
			state.assets = results.filter((result) => result.approved).map((result) => result.assetId);
			state.status = "READY_TO_SETTLE";
		},
		async recordFinalizationRetry() {},
		async claimSettlement() {
			if (state.status !== "READY_TO_SETTLE") return null;
			state.status = "SETTLING";
			return {
				jobId: "job-1",
				reservationId: "reservation-1",
				reservedCredits: 4n,
				chargeCredits: 4n,
				readyOutputCount: state.assets.length,
				providerCostMicros: 1_000n,
			};
		},
		async settle() {
			state.settlementCount += 1;
			state.status = state.assets.length > 0 ? "SUCCEEDED" : "FAILED";
		},
	};
}
