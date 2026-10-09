type PreviewTiming = {
	jobId: string;
	assetId: string;
	requestId?: string;
	receivedAt: number;
	loadedAt?: number;
	requestStartedAt?: number | null;
	visible?: boolean;
};
const timings = new Map<string, PreviewTiming>();
const acceptedJobs = new Map<string, { acceptedAt: number; visible: boolean }>();

export function recordGenerationAccepted(jobId: string, startedAt: number) {
	const acceptedAt = performance.now();
	if (!acceptedJobs.has(jobId)) {
		if (acceptedJobs.size >= 32) acceptedJobs.delete(acceptedJobs.keys().next().value!);
		acceptedJobs.set(jobId, { acceptedAt, visible: false });
	}
	safeInfo("media.generation.timing", {
		jobId,
		stage: "accepted",
		elapsedMs: acceptedAt - startedAt,
		startBoundary: "submit-generation-call",
	});
}

export function observeGenerationJobVisibility(
	jobId: string,
	element: HTMLElement | null,
	isCurrent?: () => boolean,
) {
	const timing = acceptedJobs.get(jobId);
	if (!timing || timing.visible || !element || typeof requestAnimationFrame !== "function") return;
	const taskRegion = element;
	const acceptedTiming = timing;
	let canceled = false;
	let frame: number | null = null;
	let intersection: IntersectionObserver | undefined;
	const cleanup = () => {
		canceled = true;
		if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
		intersection?.disconnect();
		document.removeEventListener?.("visibilitychange", schedule);
		window.removeEventListener?.("scroll", schedule, true);
		window.removeEventListener?.("resize", schedule);
	};
	function schedule() {
		if (canceled || frame !== null) return;
		frame = requestAnimationFrame(() => {
			if (canceled) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				if (canceled) return;
				if (acceptedTiming.visible || acceptedJobs.get(jobId) !== acceptedTiming) {
					cleanup();
					return;
				}
				try {
					if (isCurrent && !isCurrent()) {
						cleanup();
						return;
					}
					if (
						document.visibilityState !== "visible" ||
						!taskRegion.isConnected ||
						typeof taskRegion.checkVisibility !== "function" ||
						!taskRegion.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
					)
						return;
					const rect = taskRegion.getBoundingClientRect();
					if (
						rect.width <= 0 ||
						rect.height <= 0 ||
						rect.bottom <= 0 ||
						rect.right <= 0 ||
						rect.top >= window.innerHeight ||
						rect.left >= window.innerWidth
					)
						return;
					acceptedTiming.visible = true;
					safeInfo("media.generation.timing", {
						jobId,
						stage: "job-visible",
						elapsedMs: performance.now() - acceptedTiming.acceptedAt,
						startBoundary: "submit-generation-response",
						visibilityMethod: "task-region-plus-two-animation-frames",
					});
					cleanup();
				} catch {
					// Optional visibility diagnostics must never change task display.
				}
			});
		});
	}
	try {
		if (typeof IntersectionObserver === "function") {
			intersection = new IntersectionObserver(schedule);
			intersection.observe(element);
		} else {
			window.addEventListener?.("scroll", schedule, true);
		}
		window.addEventListener?.("resize", schedule);
		document.addEventListener?.("visibilitychange", schedule);
		schedule();
	} catch {
		cleanup();
	}
	return cleanup;
}

export function recordOutputReceived(jobId: string, assetId: string, requestId?: string) {
	const key = `${jobId}:${assetId}`;
	if (timings.has(key)) return;
	if (timings.size >= 32) timings.delete(timings.keys().next().value!);
	const timing = { jobId, assetId, requestId, receivedAt: performance.now() };
	timings.set(key, timing);
	emit(timing, "received");
}

export function recordOutputLoaded(jobId: string, assetId: string, element?: HTMLImageElement) {
	const timing = timings.get(`${jobId}:${assetId}`);
	if (!timing || timing.loadedAt !== undefined) return;
	timing.loadedAt = performance.now();
	timing.requestStartedAt = readImageRequestStart(element, timing.receivedAt, timing.loadedAt);
	emit(timing, "loaded");
	// Two animation frames approximate painted visibility, not compositor timing.
	if (typeof requestAnimationFrame !== "function") return;
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			if (
				document.visibilityState !== "visible" ||
				timing.visible ||
				!element?.isConnected ||
				!element.naturalWidth
			)
				return;
			if (
				typeof element.checkVisibility !== "function" ||
				!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
			)
				return;
			const rect = element.getBoundingClientRect();
			if (
				rect.width <= 0 ||
				rect.height <= 0 ||
				rect.bottom <= 0 ||
				rect.right <= 0 ||
				rect.top >= window.innerHeight ||
				rect.left >= window.innerWidth
			)
				return;
			timing.visible = true;
			emit(timing, "visible");
		}),
	);
}

function readImageRequestStart(
	element: HTMLImageElement | undefined,
	receivedAt: number,
	loadedAt: number,
) {
	try {
		const resourceUrl = element?.currentSrc || element?.src;
		if (!resourceUrl) return null;
		const entries = performance.getEntriesByName(resourceUrl, "resource");
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index] as PerformanceResourceTiming;
			if (
				entry.initiatorType === "img" &&
				Number.isFinite(entry.startTime) &&
				entry.startTime >= receivedAt &&
				entry.startTime <= loadedAt
			) {
				return entry.startTime;
			}
		}
	} catch {
		// Missing/blocked resource timing must never change preview behavior.
	}
	return null;
}

function emit(timing: PreviewTiming, stage: "received" | "loaded" | "visible") {
	safeInfo("media.preview.timing", {
		jobId: timing.jobId,
		assetId: timing.assetId,
		requestId: timing.requestId,
		stage,
		elapsedMs: performance.now() - timing.receivedAt,
		loadMs: timing.loadedAt === undefined ? null : timing.loadedAt - timing.receivedAt,
		requestStartMs:
			timing.requestStartedAt == null ? null : timing.requestStartedAt - timing.receivedAt,
		requestStartSource: timing.requestStartedAt == null ? "unmeasured" : "resource-timing",
		visibilityMethod: "load-plus-two-animation-frames",
	});
}

function safeInfo(event: string, fields: Record<string, unknown>) {
	try {
		console.info(event, fields);
	} catch {
		// Optional diagnostics cannot change submission or preview behavior.
	}
}
