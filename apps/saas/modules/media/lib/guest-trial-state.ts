export type GuestTrialServerStage =
	| "WAITING"
	| "EDITING"
	| "FINISHING"
	| "READY"
	| "REJECTED"
	| "FAILED"
	| "EXPIRED";

export interface GuestTrialSnapshot {
	jobId: string;
	stage: GuestTrialServerStage;
	projectedDispatchAt: string;
	estimateExpiresAt: string;
	resultExpiresAt: string;
	resultAssetId: string | null;
	watermarked: boolean;
	trialConsumed: boolean;
	linkReady: boolean;
}

export type GuestTrialViewState =
	| "preparingSession"
	| "waiting"
	| "editing"
	| "finishing"
	| "moderatingOutput"
	| "ready"
	| "delayed"
	| "rejected"
	| "failed"
	| "expired";

export interface GuestTrialView {
	state: GuestTrialViewState;
	jobId?: string;
	resultAssetId?: string;
	projectedDispatchAt?: string;
	estimateExpiresAt?: string;
	resultExpiresAt?: string;
	trialConsumed?: boolean;
	linkReady?: boolean;
}

export function resolveGuestTrialView(
	snapshot: GuestTrialSnapshot | null,
	now: Date,
): GuestTrialView {
	if (!snapshot) return { state: "preparingSession" };
	const common = {
		jobId: snapshot.jobId,
		projectedDispatchAt: snapshot.projectedDispatchAt,
		estimateExpiresAt: snapshot.estimateExpiresAt,
		resultExpiresAt: snapshot.resultExpiresAt,
		trialConsumed: snapshot.trialConsumed,
		linkReady: snapshot.linkReady,
	};
	if (atOrAfter(now, snapshot.resultExpiresAt) || snapshot.stage === "EXPIRED") {
		return { ...common, state: "expired" };
	}
	switch (snapshot.stage) {
		case "WAITING":
			return {
				...common,
				state: atOrAfter(now, snapshot.estimateExpiresAt) ? "delayed" : "waiting",
			};
		case "EDITING":
			return { ...common, state: "editing" };
		case "FINISHING":
			return { ...common, state: "finishing" };
		case "READY":
			return snapshot.watermarked && snapshot.resultAssetId
				? { ...common, state: "ready", resultAssetId: snapshot.resultAssetId }
				: { ...common, state: "moderatingOutput" };
		case "REJECTED":
			return { ...common, state: "rejected" };
		case "FAILED":
			return { ...common, state: "failed" };
	}
}

export function isGuestTrialTerminal(state: GuestTrialViewState): boolean {
	return ["ready", "rejected", "failed", "expired"].includes(state);
}

function atOrAfter(now: Date, timestamp: string): boolean {
	const value = new Date(timestamp).getTime();
	return Number.isFinite(value) && now.getTime() >= value;
}
