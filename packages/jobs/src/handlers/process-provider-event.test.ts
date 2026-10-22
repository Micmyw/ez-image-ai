import { describe, expect, it, vi } from "vitest";

import {
	ProviderEventPhaseHeldError,
	type ProviderEventClaim,
	type ProviderEventStore,
} from "../contracts";
import { processProviderEvent } from "./process-provider-event";

const claim: ProviderEventClaim = {
	eventId: "event",
	attemptId: "attempt",
	provider: "kie",
	processingToken: "token",
	receivedAt: new Date(),
	snapshot: { providerTaskId: "task", status: "SUCCEEDED", raw: {} },
};

function fixture() {
	const store = {
		claimProviderEvent: vi.fn().mockResolvedValue(claim),
		recordProviderProgress: vi.fn(),
		markProviderRecoveryUnavailable: vi.fn(),
		recordProviderEventFailure: vi.fn(),
	} satisfies ProviderEventStore;
	const normalizeResult = vi.fn().mockResolvedValue({
		outputs: [],
		progress: null,
		providerCostMicros: null,
		providerCharged: false,
		failure: null,
		retryable: false,
	});
	const getProvider = vi.fn(() => ({
		provider: "kie" as const,
		normalizeResult,
		submit: vi.fn(),
		retrieve: vi.fn(),
	}));
	return { store, normalizeResult, getProvider };
}

describe("provider callback delivery held by a phase owner", () => {
	it.each(["claim", "progress", "unavailable"] as const)(
		"retains durable retry on %s without recording invalid-provider failure",
		async (stage) => {
			const f = fixture();
			if (stage === "claim")
				vi.mocked(f.store.claimProviderEvent).mockRejectedValue(new ProviderEventPhaseHeldError());
			if (stage === "progress")
				vi.mocked(f.store.recordProviderProgress).mockRejectedValue(
					new ProviderEventPhaseHeldError(),
				);
			if (stage === "unavailable") {
				f.getProvider.mockImplementation(() => {
					throw new Error("ADAPTER_UNAVAILABLE");
				});
				vi.mocked(f.store.markProviderRecoveryUnavailable).mockRejectedValue(
					new ProviderEventPhaseHeldError(),
				);
			}
			await expect(
				processProviderEvent({ providerWebhookEventId: "event" }, f),
			).rejects.toBeInstanceOf(ProviderEventPhaseHeldError);
			expect(f.store.recordProviderEventFailure).not.toHaveBeenCalled();
			if (stage === "claim") expect(f.getProvider).not.toHaveBeenCalled();
		},
	);

	it("retains ordinary invalid-response handling", async () => {
		const f = fixture();
		f.normalizeResult.mockRejectedValue(new Error("invalid response"));
		await expect(processProviderEvent({ providerWebhookEventId: "event" }, f)).resolves.toEqual({
			outcome: "FAILED",
		});
		expect(f.store.recordProviderEventFailure).toHaveBeenCalledWith(
			claim,
			"PROVIDER_RESPONSE_INVALID",
		);
	});
});
