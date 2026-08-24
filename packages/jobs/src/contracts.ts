import type {
	MediaProviderAdapter,
	RetrieveOnlyMediaProviderAdapter,
	NormalizedResult,
	ProviderExecutionInput,
	ProviderKey,
	ProviderOutput,
	ProviderFailure,
	ProviderSubmission,
	ProviderTaskSnapshot,
} from "@repo/ai";

export interface JobPayload {
	jobId: string;
	version: number;
}

export interface ProviderWebhookPayload {
	providerWebhookEventId: string;
}

export interface OutboxPayload {
	outboxEventId?: string;
}

export interface DispatchClaim {
	attemptId: string;
	provider: ProviderKey;
	providerModelId: string;
	input: ProviderExecutionInput;
	webhookUrl?: string;
	mediaKind: "image" | "video";
	queueKey: string;
}

export interface DispatchStore {
	claimDispatch(payload: JobPayload): Promise<DispatchClaim | null>;
	recordSubmission(attemptId: string, submission: ProviderSubmission): Promise<void>;
	recordSynchronousCompletion(
		attemptId: string,
		submission: ProviderSubmission,
		result: NormalizedResult,
	): Promise<void>;
	recordUncertainSubmission(attemptId: string): Promise<void>;
	recordRejectedSubmission(attemptId: string, failure: ProviderFailure): Promise<void>;
}

export interface DispatchDependencies {
	store: DispatchStore;
	getProvider(provider: ProviderKey): MediaProviderAdapter;
	isGenerationEnabled?(): boolean;
}

export interface ProviderEventClaim {
	eventId: string;
	attemptId: string;
	provider: ProviderKey;
	snapshot: ProviderTaskSnapshot;
	receivedAt: Date;
	providerOccurredAt?: Date;
	providerSequence?: bigint;
	processingToken: string;
}

export interface ProviderEventStore {
	claimProviderEvent(eventId: string): Promise<ProviderEventClaim | null>;
	recordProviderProgress(claim: ProviderEventClaim, result: NormalizedResult): Promise<void>;
	recordProviderEventFailure(claim: ProviderEventClaim, code: string): Promise<void>;
}

export interface ProviderEventDependencies {
	store: ProviderEventStore;
	getProvider(provider: ProviderKey): MediaProviderAdapter;
}

export interface FinalizationCandidate {
	key: string;
	output: ProviderOutput;
}

export interface FinalizationClaim {
	jobId: string;
	ownerId: string;
	mediaKind: "image" | "video";
	candidates: FinalizationCandidate[];
}

export interface PersistedCandidate {
	assetId: string;
	approved: boolean;
}

export interface FinalizationFailure {
	stage: "TRANSFER" | "MODERATION";
	code: string;
	retryable: boolean;
	candidateKey?: string;
	assetId?: string;
	transferToken?: string;
}

export const MAX_TRANSIENT_FINALIZATION_RETRIES = 5;

export type FinalizationRetryResolution =
	| { outcome: "RETRY_SCHEDULED"; retryCount: number }
	| { outcome: "TERMINAL"; retryCount: number };

export interface FinalizationStore {
	claimFinalization(payload: JobPayload): Promise<FinalizationClaim | null>;
	findPersistedCandidate(jobId: string, candidateKey: string): Promise<PersistedCandidate | null>;
	recordFinalization(
		claim: FinalizationClaim,
		results: Array<PersistedCandidate & { candidateKey: string }>,
		failure?: FinalizationFailure,
	): Promise<void>;
	/**
	 * A terminal resolution has already bound any usable results, persisted the
	 * failure evidence, and queued settlement. Keeping `void` in the union lets
	 * older stores remain source-compatible until their runtime implementation is
	 * upgraded to the bounded policy.
	 */
	recordFinalizationRetry(
		claim: FinalizationClaim,
		failure: FinalizationFailure,
		results?: Array<PersistedCandidate & { candidateKey: string }>,
	): Promise<FinalizationRetryResolution | void>;
}

export interface FinalizationDependencies {
	store: FinalizationStore;
	persistCandidate(
		claim: FinalizationClaim,
		candidate: FinalizationCandidate,
	): Promise<PersistedCandidate>;
	maxInlineImageBytes?: number;
}

export interface SettlementClaim {
	jobId: string;
	reservationId: string;
	reservedCredits: bigint;
	chargeCredits: bigint;
	readyOutputCount: number;
	providerCostMicros: bigint;
	failureCode?: string | null;
}

export interface SettlementStore {
	claimSettlement(payload: JobPayload): Promise<SettlementClaim | null>;
	settle(claim: SettlementClaim): Promise<void>;
}

export interface SettlementDependencies {
	store: SettlementStore;
}

export interface ReconciliationLease {
	jobId: string;
	version: number;
	attemptId: string;
	provider: ProviderKey;
	providerTaskId?: string;
	statusUrl?: string;
	resultUrl?: string;
	leaseToken: string;
	staleAgeMinutes: number;
	repairCount: number;
}

export interface ReconciliationStore {
	claimStale(input: {
		limit: number;
		leaseSeconds: number;
		now: Date;
	}): Promise<ReconciliationLease[]>;
	recordReconciled(
		lease: ReconciliationLease,
		snapshot: ProviderTaskSnapshot,
		result: NormalizedResult,
	): Promise<void>;
	releaseReconciliationLease(
		lease: ReconciliationLease,
		code: string,
		retryAt: Date,
	): Promise<void>;
	markUncertainForManualReconciliation(lease: ReconciliationLease): Promise<void>;
}

export interface ReconciliationDependencies {
	store: ReconciliationStore;
	getProvider(provider: ProviderKey): MediaProviderAdapter | RetrieveOnlyMediaProviderAdapter;
	now?: () => Date;
}

export interface OutboxLease {
	id: string;
	eventType: string;
	aggregateId: string;
	payload: unknown;
	leaseToken: string;
	attempts: number;
}

export interface OutboxStore {
	claimBatch(input: {
		workerId: string;
		limit: number;
		leaseSeconds: number;
	}): Promise<OutboxLease[]>;
	complete(id: string, workerId: string, leaseToken: string): Promise<void>;
	release(input: {
		id: string;
		workerId: string;
		leaseToken: string;
		errorCode: string;
		retryAt: Date;
	}): Promise<void>;
}

export interface OutboxDependencies {
	store: OutboxStore;
	deliver(event: OutboxLease): Promise<void>;
	now?: () => Date;
}
