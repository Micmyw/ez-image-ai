/** Evidence collection only. This window never changes a performance budget. */
export const SCANLESS_NOTIFICATION_OBSERVATION_MS = 1_000;

interface ClockPoint {
	at: number;
	monotonic: number;
}

export interface ScanlessNotificationReceipt extends Record<string, unknown> {
	receivedAt: number;
	receivedMonotonic: number;
}

export interface ScanlessNotificationObservation {
	jobId: string;
	assetId: string;
	windowMs: number;
	visibleAt: number;
	visibleMonotonic: number;
	startedAt: number;
	startedMonotonic: number;
	deadlineMonotonic: number;
	endedAt: number;
	endedMonotonic: number;
	deadlineOverrunMs: number;
	reason: "ready-received" | "deadline" | "cancelled";
	notifications: ScanlessNotificationReceipt[];
}

/** One timer, no polling or I/O. Receipts come only from the browser's socket observer. */
export function createScanlessNotificationObservation(
	options: {
		now?: () => ClockPoint;
		schedule?: (callback: () => void, milliseconds: number) => () => void;
	} = {},
) {
	const now = options.now ?? (() => ({ at: Date.now(), monotonic: performance.now() }));
	const schedule =
		options.schedule ??
		((callback, milliseconds) => {
			const timer = setTimeout(callback, milliseconds);
			return () => clearTimeout(timer);
		});
	const notifications: ScanlessNotificationReceipt[] = [];
	const snapshot = () => notifications.map((message) => ({ ...message }));
	let listener: ((receipt: ScanlessNotificationReceipt) => void) | undefined;
	let cancel: (() => void) | undefined;
	let started = false;
	return {
		snapshot,
		record(message: Record<string, unknown>) {
			const point = now();
			const receipt = { ...message, receivedAt: point.at, receivedMonotonic: point.monotonic };
			notifications.push(receipt);
			listener?.(receipt);
		},
		cancel: () => cancel?.(),
		waitForReady(input: {
			jobId: string;
			assetId: string;
			visibleAt: number;
			visibleMonotonic: number;
		}): Promise<ScanlessNotificationObservation> {
			if (started) throw new Error("SCANLESS_NOTIFICATION_OBSERVATION_ALREADY_STARTED");
			started = true;
			const start = now();
			const deadline = input.visibleMonotonic + SCANLESS_NOTIFICATION_OBSERVATION_MS;
			const matches = (message: ScanlessNotificationReceipt) =>
				message.type === "job-updated" &&
				message.jobId === input.jobId &&
				typeof message.eventId === "string" &&
				/^mju_[a-f0-9]{64}$/.test(message.eventId) &&
				typeof message.version === "string" &&
				message.version.startsWith(`asset:${input.assetId}:`) &&
				message.version.endsWith(":ready") &&
				message.receivedMonotonic <= deadline;
			return new Promise((resolve) => {
				let finished = false;
				let clearDeadline: (() => void) | undefined;
				const finish = (reason: ScanlessNotificationObservation["reason"], end: ClockPoint) => {
					if (finished) return;
					finished = true;
					clearDeadline?.();
					listener = undefined;
					cancel = undefined;
					resolve({
						...input,
						windowMs: SCANLESS_NOTIFICATION_OBSERVATION_MS,
						startedAt: start.at,
						startedMonotonic: start.monotonic,
						deadlineMonotonic: deadline,
						endedAt: end.at,
						endedMonotonic: end.monotonic,
						deadlineOverrunMs: Math.max(0, end.monotonic - deadline),
						reason,
						notifications: snapshot(),
					});
				};
				cancel = () => finish("cancelled", now());
				listener = (receipt) => {
					const point = { at: receipt.receivedAt, monotonic: receipt.receivedMonotonic };
					// A delayed timer must not admit receipts after the fixed observation deadline.
					if (receipt.receivedMonotonic > deadline) finish("deadline", point);
					else if (matches(receipt)) finish("ready-received", point);
				};
				if (notifications.some(matches)) finish("ready-received", start);
				else if (start.monotonic >= deadline) finish("deadline", start);
				else clearDeadline = schedule(() => finish("deadline", now()), deadline - start.monotonic);
			});
		},
	};
}

/** A hub/Outbox ACK is never a browser receipt; require the exact committed event and version. */
export function hasScanlessCommittedReadyReceipt(input: {
	jobId: string;
	eventId: string;
	version: string;
	observation: unknown;
}): boolean {
	const value = input.observation as ScanlessNotificationObservation | undefined;
	if (
		!value ||
		value.jobId !== input.jobId ||
		value.reason !== "ready-received" ||
		value.windowMs !== SCANLESS_NOTIFICATION_OBSERVATION_MS ||
		!Number.isFinite(value.visibleAt) ||
		!Number.isFinite(value.visibleMonotonic) ||
		!Number.isFinite(value.deadlineMonotonic) ||
		value.deadlineMonotonic !== value.visibleMonotonic + SCANLESS_NOTIFICATION_OBSERVATION_MS ||
		!Number.isFinite(value.endedMonotonic) ||
		!Array.isArray(value.notifications)
	)
		return false;
	return value.notifications.some(
		(message) =>
			message !== null &&
			typeof message === "object" &&
			message.type === "job-updated" &&
			message.jobId === input.jobId &&
			message.eventId === input.eventId &&
			message.version === input.version &&
			Number.isFinite(message.receivedAt) &&
			Number.isFinite(message.receivedMonotonic) &&
			message.receivedMonotonic <= value.deadlineMonotonic &&
			message.receivedMonotonic <= value.endedMonotonic,
	);
}
