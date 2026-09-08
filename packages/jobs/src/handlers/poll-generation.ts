import type { GenerationPollingStore, ReconciliationDependencies } from "../contracts";
import { reconcileGenerations } from "./reconcile-generations";

interface GenerationPollingDependencies extends Omit<
	ReconciliationDependencies,
	"store" | "schedulePolling"
> {
	store: GenerationPollingStore;
	/** Trigger durable waits release worker capacity; unit tests use a virtual clock. */
	wait(seconds: number): Promise<void>;
}

export async function pollGeneration(
	input: { attemptId: string },
	dependencies: GenerationPollingDependencies,
): Promise<{ outcome: "STOPPED" | "RECOVERY_PENDING"; polls: number }> {
	if (typeof input.attemptId !== "string" || !input.attemptId.trim()) {
		throw new Error("INVALID_GENERATION_ATTEMPT_ID");
	}
	const now = dependencies.now ?? (() => new Date());
	const deadline = now().getTime() + 600_000;
	let polls = 0;
	// Both a time bound and an iteration bound protect against clock changes or
	// repeated lost leases. The five-minute sweep remains the recovery owner.
	for (let iteration = 0; iteration < 128; iteration += 1) {
		const state = await dependencies.store.getPollingState(input.attemptId);
		if (!state) return { outcome: "STOPPED", polls };
		const remainingMs = deadline - now().getTime();
		if (remainingMs <= 0) break;
		const untilDueMs = state.pollAt.getTime() - now().getTime();
		if (untilDueMs > 0) {
			await dependencies.wait(
				Math.min(60, Math.max(5, Math.ceil(untilDueMs / 1_000)), remainingMs / 1_000),
			);
			continue;
		}
		const result = await reconcileGenerations(
			{ attemptId: input.attemptId, leaseSeconds: 300 },
			{ store: dependencies.store, getProvider: dependencies.getProvider, now },
		);
		polls += result.claimed;
		if (result.claimed === 0) await dependencies.wait(Math.min(5, remainingMs / 1_000));
	}
	return { outcome: "RECOVERY_PENDING", polls };
}
