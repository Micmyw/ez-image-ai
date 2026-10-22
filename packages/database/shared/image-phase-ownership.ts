/** Private orchestration identity; never a moderation verdict or provider acceptance. */
export interface ImagePhaseOwner {
	workflowId: string;
	phaseKey: string;
	epoch: number;
}

export interface ImagePhaseContext {
	workflowId?: string;
	phaseOwner?: ImagePhaseOwner;
}

export interface ImagePhaseWakeResult {
	status: "ready" | "recorded" | "terminal" | "invalid";
	phaseOwner?: ImagePhaseOwner;
}

export type ImageWorkflowPhase =
	| { kind: "verification"; assetId: string; generation: number }
	| { kind: "generation"; attemptId: string };

export interface ImagePhaseIdentity {
	phaseKind: ImageWorkflowPhase["kind"];
	subjectId: string;
	generation: number;
}

export interface ImagePhaseLease extends ImagePhaseOwner {
	leasedUntil: Date;
}

export interface ImagePhaseClaim {
	owned: boolean;
	phaseOwner?: ImagePhaseOwner;
}

export interface ImagePhaseOwnershipPort {
	read(identity: ImagePhaseIdentity): Promise<{ lease: ImagePhaseLease | null; now: Date }>;
	write(
		identity: ImagePhaseIdentity,
		lease: ImagePhaseLease,
		previous: ImagePhaseLease | null,
	): Promise<boolean>;
}

// Covers the existing 300-second execution lease and at most 60 seconds of
// durable waiting. Every owned tick renews it; timeout recovery may take over.
export const IMAGE_PHASE_OWNER_LEASE_MS = 600_000;

export function imagePhaseIdentity(phase: ImageWorkflowPhase): ImagePhaseIdentity {
	const subjectId = phase.kind === "verification" ? phase.assetId : phase.attemptId;
	const generation = phase.kind === "verification" ? phase.generation : 0;
	if (
		!["verification", "generation"].includes(phase.kind) ||
		typeof subjectId !== "string" ||
		!/^[a-zA-Z0-9_-]{1,128}$/.test(subjectId) ||
		!Number.isSafeInteger(generation) ||
		generation < (phase.kind === "verification" ? 1 : 0)
	)
		throw new Error("INVALID_IMAGE_WORKFLOW_PHASE");
	return { phaseKind: phase.kind, subjectId, generation };
}

export function imagePhaseOwner(lease: ImagePhaseLease): ImagePhaseOwner {
	return { workflowId: lease.workflowId, phaseKey: lease.phaseKey, epoch: lease.epoch };
}

export function sameImagePhaseOwner(left: ImagePhaseOwner, right: ImagePhaseOwner): boolean {
	return (
		left.workflowId === right.workflowId &&
		left.phaseKey === right.phaseKey &&
		left.epoch === right.epoch
	);
}

/** The caller holds the authoritative asset-generation or attempt lock. */
export async function acquireImagePhaseOwnership(
	input: {
		phase: ImageWorkflowPhase;
		workflowId: string;
		expectedOwner?: ImagePhaseOwner;
		businessLeasedUntil?: Date | null;
	},
	port: ImagePhaseOwnershipPort,
): Promise<ImagePhaseClaim> {
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.workflowId))
		throw new Error("INVALID_IMAGE_WORKFLOW_ID");
	const identity = imagePhaseIdentity(input.phase);
	const { lease, now } = await port.read(identity);
	const live = lease !== null && lease.leasedUntil > now;
	const current = live ? imagePhaseOwner(lease) : undefined;
	if (
		input.expectedOwner &&
		(!live ||
			input.expectedOwner.workflowId !== input.workflowId ||
			!sameImagePhaseOwner(input.expectedOwner, lease))
	)
		return { owned: false, ...(current ? { phaseOwner: current } : {}) };
	if (live && lease.workflowId !== input.workflowId) return { owned: false, phaseOwner: current };
	if (!live && input.businessLeasedUntil && input.businessLeasedUntil > now)
		return { owned: false };
	const next: ImagePhaseLease = {
		phaseKey: lease?.phaseKey ?? crypto.randomUUID(),
		workflowId: input.workflowId,
		epoch: live ? lease.epoch : (lease?.epoch ?? 0) + 1,
		leasedUntil: new Date(now.getTime() + IMAGE_PHASE_OWNER_LEASE_MS),
	};
	if (!(await port.write(identity, next, lease))) return { owned: false };
	return { owned: true, phaseOwner: imagePhaseOwner(next) };
}
