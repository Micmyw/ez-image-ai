import { ReplicateProviderAdapter } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

import { dispatchGeneration } from "./dispatch-generation";

describe("dispatch generation security gates", () => {
	it("rejects before claiming or contacting a provider when generation is disabled", async () => {
		const claimDispatch = vi.fn();
		const getProvider = vi.fn();

		await expect(
			dispatchGeneration(
				{ jobId: "job-1", version: 1 },
				{
					store: { claimDispatch } as never,
					getProvider,
					isGenerationEnabled: () => false,
				},
			),
		).rejects.toThrow("MEDIA_GENERATION_DISABLED");
		expect(claimDispatch).not.toHaveBeenCalled();
		expect(getProvider).not.toHaveBeenCalled();
	});

	it("preserves an incomplete provider 2xx submission for reconciliation instead of failing over", async () => {
		const recordUncertainSubmission = vi.fn(async () => undefined);
		const recordRejectedSubmission = vi.fn(async () => undefined);

		await expect(
			dispatchGeneration(
				{ jobId: "job-1", version: 1 },
				{
					store: {
						claimDispatch: vi.fn(async () => ({
							attemptId: "attempt-1",
							provider: "replicate" as const,
							providerModelId: "model-1",
							mediaKind: "image" as const,
							queueKey: "replicate:model-1",
							input: { kind: "text-to-image" as const, prompt: "x" },
						})),
						recordUncertainSubmission,
						recordRejectedSubmission,
					} as never,
					getProvider: () =>
						new ReplicateProviderAdapter({
							apiToken: "test",
							fetch: (async () =>
								new Response(JSON.stringify({ status: "starting" }), {
									status: 200,
								})) as typeof fetch,
						}),
				},
			),
		).resolves.toEqual({ outcome: "RECONCILE" });

		expect(recordUncertainSubmission).toHaveBeenCalledWith("attempt-1");
		expect(recordRejectedSubmission).not.toHaveBeenCalled();
	});

	it("preserves an invalid-JSON provider 2xx submission for reconciliation instead of failing over", async () => {
		const recordUncertainSubmission = vi.fn(async () => undefined);
		const recordRejectedSubmission = vi.fn(async () => undefined);

		await expect(
			dispatchGeneration(
				{ jobId: "job-1", version: 1 },
				{
					store: {
						claimDispatch: vi.fn(async () => ({
							attemptId: "attempt-1",
							provider: "replicate" as const,
							providerModelId: "model-1",
							mediaKind: "image" as const,
							queueKey: "replicate:model-1",
							input: { kind: "text-to-image" as const, prompt: "x" },
						})),
						recordUncertainSubmission,
						recordRejectedSubmission,
					} as never,
					getProvider: () =>
						new ReplicateProviderAdapter({
							apiToken: "test",
							fetch: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
						}),
				},
			),
		).resolves.toEqual({ outcome: "RECONCILE" });

		expect(recordUncertainSubmission).toHaveBeenCalledWith("attempt-1");
		expect(recordRejectedSubmission).not.toHaveBeenCalled();
	});
});
