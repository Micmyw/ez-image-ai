import { MediaProviderError, ReplicateProviderAdapter } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

import { DispatchAdmissionBlockedError } from "../contracts";
import { dispatchGeneration } from "./dispatch-generation";

describe("dispatch generation recovery boundary", () => {
	it.each(["http", "transport"])(
		"retains selected failure diagnostics for %s without changing submission uncertainty",
		async (kind) => {
			const recordUncertainSubmission = vi.fn();
			const recordRejectedSubmission = vi.fn();
			const adapter = new ReplicateProviderAdapter({
				apiToken: "opaque-credential",
				fetch: async () => {
					if (kind === "transport")
						throw new MediaProviderError(
							"HTTP_ERROR",
							"Transport unavailable https://private.invalid/input?token=secret",
							true,
						);
					return new Response(
						JSON.stringify({ detail: "Capacity unavailable opaque-credential" }),
						{ status: 503 },
					);
				},
			});
			expect(
				await dispatchGeneration(
					{ jobId: "job", version: 0 },
					{
						isGenerationEnabled: () => true,
						getProvider: () => adapter,
						store: {
							claimDispatch: async () => ({
								attemptId: "attempt",
								provider: "replicate",
								providerModelId: "model",
								input: { kind: "text-to-image", prompt: "A lake" },
							}),
							recordSubmissionStarted: async () => true,
							recordUncertainSubmission,
							recordRejectedSubmission,
						} as never,
					},
				),
			).toEqual({ outcome: "RECONCILE" });
			const evidence = recordUncertainSubmission.mock.calls[0]?.[1];
			expect(evidence).toMatchObject({
				classification: kind === "http" ? "ambiguous_http" : "transport",
				phase: "post_send",
				failure: { code: kind === "http" ? "HTTP_503" : "HTTP_ERROR" },
			});
			expect(evidence.failure.messageOrigin).toBe(
				kind === "http" ? "provider-response" : undefined,
			);
			expect(evidence.failure.message).not.toMatch(
				/opaque-credential|private\.invalid|token=secret/,
			);
			expect(recordRejectedSubmission).not.toHaveBeenCalled();
		},
	);
	it("returns committed queue control without resolving an adapter or starting a submission", async () => {
		const getProvider = vi.fn();
		const recordSubmissionStarted = vi.fn();
		const continuation = { eventIds: ["capacity-retry"], notBefore: 1_800_000_000_000 };
		await expect(
			dispatchGeneration(
				{ jobId: "job-1", version: 3 },
				{
					store: {
						claimDispatch: async () => ({ deferred: true, retryAfterMs: 5_000, continuation }),
						recordSubmissionStarted,
					} as never,
					getProvider,
					isGenerationEnabled: () => true,
				},
			),
		).resolves.toEqual({ outcome: "DEFERRED", retryAfterMs: 5_000, continuation });
		expect(getProvider).not.toHaveBeenCalled();
		expect(recordSubmissionStarted).not.toHaveBeenCalled();
	});
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
