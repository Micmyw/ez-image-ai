export interface ScanlessMeasurementModes {
	admissionDispatchMode: "await-dispatch" | "deferred";
	inputReviewMode: "submit-time" | "pre-reviewed" | "upload-reviewed" | "upload-pending";
}

/** Keep the original baseline explicit; launchers may opt into the real API defer hook. */
export function resolveScanlessMeasurementModes(input: {
	admissionDispatchMode?: string;
	inputReviewMode?: string;
}): ScanlessMeasurementModes {
	const admissionDispatchMode = input.admissionDispatchMode ?? "await-dispatch";
	const inputReviewMode = input.inputReviewMode ?? "submit-time";
	if (admissionDispatchMode !== "await-dispatch" && admissionDispatchMode !== "deferred")
		throw new Error("INVALID_SCANLESS_ADMISSION_DISPATCH_MODE");
	if (
		inputReviewMode !== "submit-time" &&
		inputReviewMode !== "pre-reviewed" &&
		inputReviewMode !== "upload-reviewed" &&
		inputReviewMode !== "upload-pending"
	)
		throw new Error("INVALID_SCANLESS_INPUT_REVIEW_MODE");
	return { admissionDispatchMode, inputReviewMode };
}

/** Own already-started promises, just like waitUntil; never delay work in a thunk. */
export function createScanlessRequestDefer(input: {
	mode: ScanlessMeasurementModes["admissionDispatchMode"];
	pending: Set<Promise<void>>;
	onError(error: unknown): void;
	onEvent?(phase: "registered" | "fulfilled" | "rejected"): void;
}): ((promise: Promise<unknown>) => void) | undefined {
	if (input.mode === "await-dispatch") return undefined;
	return (promise) => {
		input.onEvent?.("registered");
		const task = Promise.resolve(promise)
			.then(
				() => input.onEvent?.("fulfilled"),
				(error) => {
					input.onError(error);
					input.onEvent?.("rejected");
				},
			)
			.finally(() => input.pending.delete(task));
		input.pending.add(task);
	};
}

/** Preparation stays in the report even when it is moved before the click. */
export function scanlessMeasurementTimeline(input: {
	preparationStartedAt: number;
	preparationReadyAt: number | null;
	uploadStartedAt?: unknown;
	uploadReturnedAt?: unknown;
	click?: unknown;
	visible?: unknown;
}) {
	const click =
		typeof input.click === "number" && Number.isFinite(input.click) ? input.click : null;
	const visible =
		typeof input.visible === "number" && Number.isFinite(input.visible) ? input.visible : null;
	const preparationReadyAt = input.preparationReadyAt;
	const uploadStartedAt =
		typeof input.uploadStartedAt === "number" && Number.isFinite(input.uploadStartedAt)
			? input.uploadStartedAt
			: null;
	const uploadReturnedAt =
		typeof input.uploadReturnedAt === "number" && Number.isFinite(input.uploadReturnedAt)
			? input.uploadReturnedAt
			: null;
	return {
		preparationStartedAt: input.preparationStartedAt,
		preparationReadyAt,
		preparationMs:
			preparationReadyAt === null ? null : preparationReadyAt - input.preparationStartedAt,
		preparedToClickMs:
			click === null || preparationReadyAt === null ? null : click - preparationReadyAt,
		clickToVisibleMs: click === null || visible === null ? null : visible - click,
		preparationToVisibleMs: visible === null ? null : visible - input.preparationStartedAt,
		uploadStartedAt,
		uploadReturnedAt,
		uploadMs:
			uploadStartedAt === null || uploadReturnedAt === null
				? null
				: uploadReturnedAt - uploadStartedAt,
		uploadToClickMs: uploadStartedAt === null || click === null ? null : click - uploadStartedAt,
		uploadToVisibleMs:
			uploadStartedAt === null || visible === null ? null : visible - uploadStartedAt,
		boundary:
			"Pre-click preparation and wait remain included; no total-cost reduction is inferred.",
	};
}
