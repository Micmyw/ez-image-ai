import {
	getAttemptGenerationContinuation,
	type ImagePhaseContext,
	type ImagePhaseOwner,
} from "@repo/database";
import { db } from "@repo/database/client";

import type { GenerationPollingStore, ReconciliationDependencies } from "../contracts";
import { reconcileGenerations } from "../handlers/reconcile-generations";
import type { PollingTickResult } from "./contracts";
import type { TaskContinuation } from "./contracts";
import { parseTaskPayload } from "./registry";

export interface PollingTickDependencies extends Omit<
	ReconciliationDependencies,
	"store" | "schedulePolling"
> {
	store: GenerationPollingStore;
	continuation?(attemptId: string): Promise<TaskContinuation>;
}

export async function executePollingTick(
	input: { attemptId: string },
	providedDependencies?: PollingTickDependencies,
	phaseContext: ImagePhaseContext = {},
): Promise<PollingTickResult> {
	const payload = parseTaskPayload("media-poll-generation", input);
	const dependencies = providedDependencies ?? (await databasePollingDependencies(phaseContext));
	const now = dependencies.now ?? (() => new Date());
	const state = await dependencies.store.getPollingState(payload.attemptId);
	if (
		state &&
		(state.phaseOwnershipLost ||
			(state.phaseOwner && state.phaseOwner.workflowId !== phaseContext.workflowId))
	)
		return {
			done: false,
			waitSeconds: 0,
			outboxCommitted: false,
			phaseOwnershipLost: true,
			...(state.phaseOwner ? { phaseOwner: state.phaseOwner } : {}),
		};
	if (!state)
		return {
			done: true,
			waitSeconds: 0,
			outboxCommitted: false,
			...(dependencies.continuation
				? { continuation: await dependencies.continuation(payload.attemptId) }
				: {}),
		};
	if (state.pollAt.getTime() > now().getTime() || (state.leasedUntil && state.leasedUntil > now()))
		return { ...nextTick(state, now()), outboxCommitted: false };
	let nextState: typeof state | null = state;
	let outboxCommitted: boolean | undefined = false;
	let retryImmediately = false;
	// A notification received during retrieve remains due when that query releases
	// its lease. Consume it in one additional scoped query instead of imposing a
	// five-second polling delay. Another active owner and failed reads never spin.
	for (let query = 0; query < 2; query++) {
		const progress = await reconcileGenerations(
			{ attemptId: payload.attemptId, leaseSeconds: 300 },
			{ store: dependencies.store, getProvider: dependencies.getProvider, now },
		);
		if (progress.phaseOwnershipLost)
			return {
				done: false,
				waitSeconds: 0,
				outboxCommitted: false,
				phaseOwnershipLost: true,
				...(progress.phaseOwner ? { phaseOwner: progress.phaseOwner } : {}),
			};
		if (progress.outboxCommitted) outboxCommitted = true;
		else if (progress.outboxCommitted === undefined && outboxCommitted !== true)
			outboxCommitted = undefined;
		nextState = await dependencies.store.getPollingState(payload.attemptId);
		if (
			nextState &&
			(nextState.phaseOwnershipLost ||
				(nextState.phaseOwner && nextState.phaseOwner.workflowId !== phaseContext.workflowId))
		)
			return {
				done: false,
				waitSeconds: 0,
				outboxCommitted: false,
				phaseOwnershipLost: true,
				...(nextState.phaseOwner ? { phaseOwner: nextState.phaseOwner } : {}),
			};
		const currentTime = now();
		retryImmediately = !!(
			progress.reconciled > 0 &&
			nextState &&
			nextState.pollAt <= currentTime &&
			(!nextState.leasedUntil || nextState.leasedUntil <= currentTime)
		);
		if (!retryImmediately) break;
	}
	return {
		...(nextState ? nextTick(nextState, now(), retryImmediately) : { done: true, waitSeconds: 0 }),
		...(dependencies.continuation
			? {
					continuation: nextState
						? { eventIds: [] }
						: await dependencies.continuation(payload.attemptId),
				}
			: {}),
		...(outboxCommitted === undefined ? {} : { outboxCommitted }),
	};
}

function nextTick(
	state: { pollAt: Date; leasedUntil?: Date | null; phaseOwner?: ImagePhaseOwner },
	now: Date,
	retryImmediately = false,
): PollingTickResult {
	const delay = Math.ceil((state.pollAt.getTime() - now.getTime()) / 1_000);
	const phase = state.phaseOwner ? { phaseOwner: state.phaseOwner } : {};
	if (!Number.isFinite(delay)) throw new Error("INVALID_GENERATION_POLLING_STATE");
	// Another executor can release its lease well before expiry. Re-read soon;
	// only the database lease owner may retrieve or persist provider results.
	if (state.leasedUntil && state.leasedUntil > now)
		return { done: false, waitSeconds: 5, ...phase };
	if (delay <= 0 && retryImmediately)
		return { done: false, waitSeconds: 0, retryImmediately: true, ...phase };
	return { done: false, waitSeconds: delay <= 0 ? 5 : Math.min(60, delay), ...phase };
}

async function databasePollingDependencies(
	phaseContext: ImagePhaseContext,
): Promise<PollingTickDependencies> {
	const runtime = await import("../runtime");
	const registry = runtime.createReconciliationProviderRegistry(process.env);
	return {
		store: runtime.createDatabaseReconciliationStore(db, phaseContext),
		continuation: (attemptId) => getAttemptGenerationContinuation(attemptId, db),
		getProvider: (provider) => runtime.getAnyRegisteredProvider(registry, provider),
	};
}
