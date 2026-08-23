import { describe, expect, it, vi } from "vitest";

import { DispatchAdmissionBlockedError } from "../contracts";
import { dispatchGeneration } from "./dispatch-generation";

describe("dispatch generation recovery boundary", () => {
	it("propagates a pre-claim transient failure without contacting a provider", async () => {
		const claimDispatch = vi.fn(async () => {
			throw new Error("temporary database failure");
		});
		const getProvider = vi.fn();

		await expect(
			dispatchGeneration(
				{ jobId: "job-1", version: 3 },
				{
					store: { claimDispatch } as never,
					getProvider,
					isGenerationEnabled: () => true,
				},
			),
		).rejects.toThrow("temporary database failure");

		expect(getProvider).not.toHaveBeenCalled();
	});

	it("does not contact a provider when a late runtime kill switch durably blocks the claim", async () => {
		const getProvider = vi.fn();

		await expect(
			dispatchGeneration(
				{ jobId: "job-1", version: 3 },
				{
					store: {
						claimDispatch: async () => {
							throw new DispatchAdmissionBlockedError();
						},
					} as never,
					getProvider,
					isGenerationEnabled: () => true,
				},
			),
		).rejects.toMatchObject({
			name: "DispatchAdmissionBlockedError",
			code: "MEDIA_GENERATION_DISABLED",
		});

		expect(getProvider).not.toHaveBeenCalled();
	});

	it("skips a replayed payload after a prior claim instead of submitting twice", async () => {
		const claimedDispatch = {
			attemptId: "attempt-1",
			provider: "replicate" as const,
			providerModelId: "black-forest-labs/flux-schnell",
			mediaKind: "image" as const,
			queueKey: "replicate:black-forest-labs/flux-schnell",
			input: { kind: "text-to-image" as const, prompt: "A calm lake" },
		};
		const claimDispatch = vi
			.fn()
			.mockResolvedValueOnce(claimedDispatch)
			.mockResolvedValueOnce(null);
		const recordSubmissionStarted = vi.fn(async () => undefined);
		const recordUncertainSubmission = vi.fn(async () => undefined);
		const getProvider = vi.fn(() => ({
			submit: async () => {
				throw new Error("temporary provider transport failure");
			},
		}));
		const dependencies = {
			store: {
				claimDispatch,
				recordSubmissionStarted,
				recordUncertainSubmission,
			} as never,
			getProvider: getProvider as never,
			isGenerationEnabled: () => true,
		};

		await expect(dispatchGeneration({ jobId: "job-1", version: 3 }, dependencies)).resolves.toEqual(
			{
				outcome: "RECONCILE",
			},
		);
		await expect(dispatchGeneration({ jobId: "job-1", version: 3 }, dependencies)).resolves.toEqual(
			{
				outcome: "SKIPPED",
			},
		);

		expect(recordSubmissionStarted).toHaveBeenCalledOnce();
		expect(recordUncertainSubmission).toHaveBeenCalledOnce();
		expect(getProvider).toHaveBeenCalledOnce();
	});
});
