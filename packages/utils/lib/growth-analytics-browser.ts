import type * as GrowthAnalytics from "./growth-analytics";
import {
	EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY,
	hasGrowthAnalyticsConsent,
} from "./growth-analytics-cookie";

type BrowserGrowthModule = Pick<typeof GrowthAnalytics, "trackBrowserGrowthEvent">;
type Track = typeof GrowthAnalytics.trackBrowserGrowthEvent;
let activeModule: BrowserGrowthModule | undefined;
let consentRevision = 0;

export function invalidatePendingBrowserGrowthAnalytics() {
	consentRevision++;
}

/** Reuse an already-loaded dispatcher synchronously, including its active content context. */
export function registerBrowserGrowthAnalytics(module: BrowserGrowthModule) {
	activeModule = module;
}

export function createLazyBrowserGrowthTracker(runtime: {
	cookie: () => string;
	load: () => Promise<BrowserGrowthModule>;
	active: () => BrowserGrowthModule | undefined;
	clearUnconsented: () => void;
	now?: () => number;
	revision?: () => number;
	page?: () => string;
}): Track {
	return async (event, options) => {
		const active = runtime.active();
		if (active) return active.trackBrowserGrowthEvent(event, options);
		if (!hasGrowthAnalyticsConsent(runtime.cookie())) {
			runtime.clearUnconsented();
			return "blocked";
		}
		// Capture absence too. A later navigation must not attach new content
		// context to an event which started before the dispatcher existed.
		const revision = runtime.revision ?? (() => consentRevision);
		const started = revision();
		const page = runtime.page ?? (() => (typeof location === "undefined" ? "" : location.pathname));
		const startedPage = page();
		let expired = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const capturedEvent = structuredClone(event);
			const capturedOptions = structuredClone(options ?? {});
			capturedOptions.attribution ??= Object.freeze({
				enabled: true,
				context: null,
				capturedAt: (runtime.now ?? Date.now)(),
			});
			const pending = runtime.load().then((module) => {
				// A late landing_viewed must never clear the next page's selected context.
				if (expired || started !== revision() || startedPage !== page()) return "blocked" as const;
				return module.trackBrowserGrowthEvent(capturedEvent, capturedOptions);
			});
			return await Promise.race([
				pending,
				new Promise<"failed">((resolve) => {
					timeout = setTimeout(() => {
						expired = true;
						resolve("failed");
					}, 1_500);
				}),
			]);
		} catch {
			return "failed";
		} finally {
			clearTimeout(timeout);
		}
	};
}

export const trackBrowserGrowthEvent = createLazyBrowserGrowthTracker({
	cookie: () => (typeof document === "undefined" ? "" : document.cookie),
	load: () => import("./growth-analytics"),
	active: () => activeModule,
	clearUnconsented: () => {
		try {
			if (typeof window !== "undefined")
				window.sessionStorage.removeItem(EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY);
		} catch {
			/* Optional storage may be disabled. */
		}
	},
});
