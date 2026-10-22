export type ScanlessUploadReviewMode = "upload-reviewed" | "upload-pending";
export type ScanlessReferenceReviewStatus =
	| "NOT_STARTED"
	| "PENDING"
	| "APPROVED"
	| "REJECTED"
	| "UNAVAILABLE";

export interface ScanlessPreClickReviewObservation {
	status: ScanlessReferenceReviewStatus;
	requestedAt: number;
	observedAt: number;
}

/** Observe the authenticated product procedure, never write or dispatch review state. */
export async function observeScanlessPreClickReview(input: {
	mode: ScanlessUploadReviewMode;
	deadlineAt: number;
	readStatus(): Promise<{ status: ScanlessReferenceReviewStatus }>;
	now(): number;
	wait(): Promise<void>;
	onObservation(observation: ScanlessPreClickReviewObservation): void;
}): Promise<ScanlessPreClickReviewObservation> {
	for (;;) {
		const requestedAt = input.now();
		if (requestedAt >= input.deadlineAt) throw new Error("UPLOAD_PRE_REVIEW_DEADLINE_EXCEEDED");
		const result = await input.readStatus();
		const observation = { status: result.status, requestedAt, observedAt: input.now() };
		input.onObservation(observation);
		if (observation.observedAt >= input.deadlineAt)
			throw new Error("UPLOAD_PRE_REVIEW_DEADLINE_EXCEEDED");
		if (result.status === "REJECTED" || result.status === "UNAVAILABLE")
			throw new Error(`UPLOAD_PRE_REVIEW_${result.status}`);
		if (input.mode === "upload-pending") {
			if (result.status !== "PENDING")
				throw new Error(`UPLOAD_PENDING_SCENARIO_NOT_EXERCISED:${result.status}`);
			return observation;
		}
		if (result.status === "APPROVED") return observation;
		if (result.status !== "PENDING")
			throw new Error(`UPLOAD_PRE_REVIEW_NOT_STARTED:${result.status}`);
		await input.wait();
	}
}

/** Keep mistimed and duplicate cases visible as failed coverage, never filter them out. */
export function scanlessUploadPreReviewErrors(input: {
	mode: ScanlessUploadReviewMode;
	clickAt: unknown;
	uploadStartedAt: unknown;
	uploadReturnedAt: unknown;
	preClickReview: ScanlessPreClickReviewObservation | null;
	reviews: readonly { id: string; readyAt: number }[];
	persistedProviderTaskId: string | null;
}): string[] {
	const errors: string[] = [];
	const finite = (value: unknown): value is number =>
		typeof value === "number" && Number.isFinite(value);
	const clickAt = input.clickAt;
	if (
		!finite(clickAt) ||
		!finite(input.uploadStartedAt) ||
		!finite(input.uploadReturnedAt) ||
		input.uploadReturnedAt < input.uploadStartedAt ||
		input.uploadReturnedAt > clickAt
	)
		errors.push("UPLOAD_CLICK_BOUNDARY_INVALID");
	const observation = input.preClickReview;
	if (
		!observation ||
		!finite(clickAt) ||
		!finite(observation.observedAt) ||
		!finite(observation.requestedAt) ||
		observation.observedAt > clickAt ||
		observation.requestedAt > observation.observedAt ||
		!finite(input.uploadReturnedAt) ||
		observation.requestedAt < input.uploadReturnedAt
	)
		errors.push("UPLOAD_PRE_CLICK_OBSERVATION_MISSING_OR_INVALID");
	if (input.reviews.length !== 1) errors.push("UPLOAD_INPUT_REVIEW_NOT_SINGLE_SUBMISSION");
	const review = input.reviews.length === 1 ? input.reviews[0] : undefined;
	if (!review || review.id !== input.persistedProviderTaskId)
		errors.push("UPLOAD_INPUT_REVIEW_TASK_CHANGED");
	if (input.mode === "upload-reviewed") {
		if (
			observation?.status !== "APPROVED" ||
			!review ||
			!finite(review.readyAt) ||
			review.readyAt > observation.observedAt
		)
			errors.push("UPLOAD_REVIEWED_SCENARIO_NOT_EXERCISED");
	} else if (
		observation?.status !== "PENDING" ||
		!review ||
		!finite(review.readyAt) ||
		!finite(clickAt) ||
		review.readyAt <= clickAt
	) {
		errors.push("UPLOAD_PENDING_SCENARIO_NOT_EXERCISED");
	}
	return errors;
}
