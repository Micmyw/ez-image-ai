import { describe, expect, it, vi } from "vitest";

import { finalizeMedia } from "./finalize-media";

describe("output PENDING handoff", () => {
	it("keeps sibling output bindings ordered while waiting, without queuing settlement", async () => {
		const claim = {
			jobId: "job",
			ownerId: "owner",
			mediaKind: "image" as const,
			candidates: [0, 1].map((index) => ({
				key: `attempt:${index}`,
				output: {
					kind: "remote-url" as const,
					url: `https://example.com/${index}`,
					trust: "untrusted-transfer-candidate" as const,
				},
			})),
		};
		const store = {
			claimFinalization: async () => claim,
			findPersistedCandidate: async () => null,
			recordFinalization: vi.fn(),
			recordFinalizationRetry: vi.fn(),
			recordFinalizationWait: vi.fn(),
		};
		const result = await finalizeMedia(
			{ jobId: "job", version: 0 },
			{
				store,
				persistCandidate: async (_claim, candidate) =>
					candidate.key.endsWith(":0")
						? {
								assetId: "pending",
								approved: false,
								moderationPending: true,
								outputReviewEventId: "event",
							}
						: { assetId: "ready", approved: true },
			},
		);
		expect(result).toMatchObject({ outcome: "WAITING_MODERATION", readyOutputs: 1 });
		expect(store.recordFinalizationWait).toHaveBeenCalledWith(
			claim,
			expect.arrayContaining([
				expect.objectContaining({ assetId: "ready", candidateKey: "attempt:1" }),
			]),
		);
		expect(store.recordFinalization).not.toHaveBeenCalled();
		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
	});
	it("returns the committed review event without retrying or settling a normal pending output", async () => {
		const store = {
			claimFinalization: vi.fn(async () => ({
				jobId: "job",
				ownerId: "owner",
				mediaKind: "image" as const,
				candidates: [
					{
						key: "attempt:0",
						output: {
							kind: "remote-url",
							url: "https://example.com/output",
							trust: "untrusted-transfer-candidate",
						},
					},
				],
			})),
			findPersistedCandidate: vi.fn(async () => null),
			recordFinalization: vi.fn(),
			recordFinalizationRetry: vi.fn(),
		};
		const result = await finalizeMedia(
			{ jobId: "job", version: 0 },
			{
				store: store as never,
				persistCandidate: async () => ({
					assetId: "asset",
					approved: false,
					moderationPending: true,
					outputReviewEventId: "committed-event",
				}),
			},
		);
		expect(result).toEqual({
			outcome: "WAITING_MODERATION",
			readyOutputs: 0,
			outputReviewEventIds: ["committed-event"],
		});
		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
		expect(store.recordFinalization).not.toHaveBeenCalled();
	});
});
