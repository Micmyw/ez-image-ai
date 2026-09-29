import type { GenerationPollingStore, ReconciliationDependencies } from "../contracts";
import { reconcileGenerations } from "../handlers/reconcile-generations";
import type { PollingTickResult } from "./contracts";
import { parseTaskPayload } from "./registry";

export interface PollingTickDependencies extends Omit<
	ReconciliationDependencies,
	"store" | "schedulePolling"
> {
	store: GenerationPollingStore;
}

export async function executePollingTick(
	input: { attemptId: string },
	providedDependencies?: PollingTickDependencies,
): Promise<PollingTickResult> {
	const payload = parseTaskPayload("media-poll-generation", input);
	const dependencies = providedDependencies ?? (await databasePollingDependencies());
	const now = dependencies.now ?? (() => new Date());
	const state = await dependencies.store.getPollingState(payload.attemptId);
	if (!state) return { done: true, waitSeconds: 0 };
	if (state.pollAt.getTime() > now().getTime()) return nextTick(state, now());
	// A Workflow step owns exactly one database-scoped tick. Workflow sleep releases
	// the Container; PostgreSQL leases and pollAt remain the execution authority.
	await reconcileGenerations(
		{ attemptId: payload.attemptId, leaseSeconds: 300 },
		{ store: dependencies.store, getProvider: dependencies.getProvider, now },
	);
	const nextState = await dependencies.store.getPollingState(payload.attemptId);
	return nextState ? nextTick(nextState, now()) : { done: true, waitSeconds: 0 };
}

function nextTick(
	state: { pollAt: Date; leasedUntil?: Date | null },
	now: Date,
): PollingTickResult {
	const delay = Math.ceil((state.pollAt.getTime() - now.getTime()) / 1_000);
	if (!Number.isFinite(delay)) throw new Error("INVALID_GENERATION_POLLING_STATE");
	// Another executor can release its lease well before expiry. Re-read soon;
	// only the database lease owner may retrieve or persist provider results.
	if (state.leasedUntil && state.leasedUntil > now) return { done: false, waitSeconds: 5 };
	return { done: false, waitSeconds: Math.min(60, Math.max(5, delay)) };
}

async function databasePollingDependencies(): Promise<PollingTickDependencies> {
	const runtime = await import("../runtime");
	const registry = runtime.createReconciliationProviderRegistry(process.env);
	return {
		store: runtime.databaseReconciliationStore,
		getProvider: (provider) => runtime.getAnyRegisteredProvider(registry, provider),
	};
}
