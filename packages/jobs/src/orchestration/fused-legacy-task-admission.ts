import { beginWorkflowOutboxExecution } from "@repo/database";
import type { PrismaClient } from "@repo/database/generated-client";

import type { TaskExecutionContext, TaskRequest } from "./contracts";
import { dispatchRouteForTask, taskDefinition } from "./registry";
import { workerExecutorLane } from "./worker-executors";

type BeginInput = Parameters<typeof beginWorkflowOutboxExecution>[0];
type BeginResult = Awaited<ReturnType<typeof beginWorkflowOutboxExecution>>;

interface AdmissionBinding {
	database: PrismaClient;
	prepared: TaskRequest;
	preparedSnapshot: string;
	context: TaskExecutionContext;
	contextSnapshot: string;
	task: TaskRequest;
	taskSnapshot: string;
}

/** Private fields survive only in this request, never RPC, cloning or JSON serialization. */
class LegacyTaskAdmissionProof {
	#binding: AdmissionBinding;
	#consumed = false;

	constructor(binding: AdmissionBinding) {
		this.#binding = binding;
		Object.freeze(this);
	}

	static consume(
		this: void,
		proof: unknown,
		task: TaskRequest,
		context: TaskExecutionContext,
		database: PrismaClient,
	): boolean {
		if (!proof || typeof proof !== "object" || !(#binding in proof)) return false;
		if (proof.#consumed) return false;
		proof.#consumed = true;
		const binding = proof.#binding;
		return (
			binding.database === database &&
			binding.task === task &&
			binding.context === context &&
			JSON.stringify(task) === binding.taskSnapshot &&
			JSON.stringify(context) === binding.contextSnapshot &&
			JSON.stringify(binding.prepared) === binding.preparedSnapshot
		);
	}
}

export type FusedLegacyTaskAdmissionProof = LegacyTaskAdmissionProof;

export const consumeFusedLegacyTaskAdmission = LegacyTaskAdmissionProof.consume;

/**
 * Only the fused wrapper owns this scope. The observation removes one redundant
 * engine read; business claims must still check current engine, ownership and leases.
 */
export function createFusedLegacyTaskAdmission(
	database: PrismaClient,
	prepared: TaskRequest,
	context: TaskExecutionContext,
) {
	const preparedSnapshot = JSON.stringify(prepared);
	const contextSnapshot = JSON.stringify(context);
	const { outboxReceipt: receipt, ...expectedTask } = prepared;
	const taskSnapshot = JSON.stringify(expectedTask);
	const eligible = Boolean(
		receipt &&
		workerExecutorLane(prepared) === "control" &&
		((prepared.taskId === "media-verify-upload" && prepared.payload.queryOnly !== true) ||
			dispatchRouteForTask(prepared.taskId)?.mediaKind === "image"),
	);
	let began = false;
	let issued = false;
	let observed: BeginResult | undefined;
	const unchanged = () =>
		JSON.stringify(prepared) === preparedSnapshot && JSON.stringify(context) === contextSnapshot;

	return {
		async begin(this: void, input: BeginInput): Promise<BeginResult> {
			const canObserve =
				!began &&
				eligible &&
				unchanged() &&
				input.eventId === receipt!.eventId &&
				input.workerId === receipt!.workerId &&
				input.leaseToken === receipt!.leaseToken &&
				input.timeoutSeconds === taskDefinition(prepared.taskId).timeoutSeconds &&
				input.allowQueryRecovery !== true;
			began = true;
			observed = undefined;
			const result = await beginWorkflowOutboxExecution(
				{ ...input, observeExecutionEngine: canObserve },
				database,
			);
			if (canObserve) observed = result;
			return result;
		},
		/** Called only by the active receipt's execute callback, after assertReceiptTask. */
		proofFor(this: void, task: TaskRequest): FusedLegacyTaskAdmissionProof | undefined {
			if (issued) return undefined;
			issued = true;
			if (
				!eligible ||
				!unchanged() ||
				JSON.stringify(task) !== taskSnapshot ||
				observed?.state !== "active" ||
				observed.engineObservation?.engine !== "legacy"
			)
				return undefined;
			const { event, engineObservation } = observed;
			const assetReview = prepared.taskId === "media-verify-upload";
			if (
				event.id !== receipt!.eventId ||
				event.leaseOwner !== receipt!.workerId ||
				event.leaseToken !== receipt!.leaseToken ||
				!event.lastError?.startsWith("EXECUTION_IN_PROGRESS:") ||
				engineObservation.aggregateType !== (assetReview ? "MEDIA_ASSET" : "GENERATION_JOB") ||
				engineObservation.aggregateId !==
					(assetReview ? prepared.payload.assetId : prepared.payload.jobId)
			)
				return undefined;
			return new LegacyTaskAdmissionProof({
				database,
				prepared,
				preparedSnapshot,
				context,
				contextSnapshot,
				task,
				taskSnapshot,
			});
		},
	};
}

export type FusedLegacyTaskAdmission = ReturnType<typeof createFusedLegacyTaskAdmission>;
