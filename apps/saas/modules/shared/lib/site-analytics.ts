import { analyticsPageLocation, publicAnalyticsPath } from "@repo/utils/lib/analytics-page";
import { browserAnalyticsPrivacySignal } from "@repo/utils/lib/analytics-policy";
import { generationDiagnosticsSchema } from "@repo/utils/lib/generation-diagnostics";

export interface SiteAnalyticsOptions {
	browser: Window;
	analyticsAllowed: boolean;
	googleAnalyticsId?: string;
	clarityProjectId?: string;
}
type Command = ((...args: unknown[]) => void) & { q?: unknown[][] };
type AnalyticsWindow = Window & {
	dataLayer?: IArguments[];
	gtag?: Command;
	clarity?: Command;
} & Partial<Record<`ga-disable-${string}`, boolean>>;
type Controller = { update: (allowed: boolean) => void };
const controllers = new WeakMap<Window, Controller>();

/** Replay includes both editors, but never account, billing, admin or sensitive URL inputs. */
export function clarityPageAllowed(url: URL): boolean {
	if (!publicAnalyticsPath(url) && !/^\/video(?:\/effects\/[a-z0-9-]+)?\/?$/.test(url.pathname))
		return false;
	if (url.hash) return false;
	return (
		[...url.searchParams.keys()].every((key) =>
			[
				"mode",
				"lang",
				"job",
				"videoJob",
				"model",
				"utm_source",
				"utm_medium",
				"utm_campaign",
				"utm_term",
				"utm_content",
			].includes(key),
		) &&
		[...url.searchParams].every(([key, value]) =>
			key.startsWith("utm_")
				? new URL(analyticsPageLocation(url)).searchParams.get(key) === value
				: /^[a-zA-Z0-9_.:-]{1,100}$/.test(value),
		)
	);
}
function referrerOrigin(referrer: string): string {
	try {
		const url = new URL(referrer);
		return ["http:", "https:"].includes(url.protocol) ? `${url.origin}/` : "";
	} catch {
		return "";
	}
}
function scheduleTagLoading(browser: Window, load: () => void): void {
	let started = false;
	let scheduled = false;
	let frame: number | undefined;
	let idle: number | undefined;
	let timer: number | undefined;
	const start = () => {
		if (started) return;
		started = true;
		browser.clearTimeout(deadline);
		if (frame !== undefined) browser.cancelAnimationFrame(frame);
		if (idle !== undefined) browser.cancelIdleCallback(idle);
		if (timer !== undefined) browser.clearTimeout(timer);
		browser.removeEventListener("load", afterLoad);
		browser.removeEventListener("pagehide", start);
		load();
	};
	const afterLoad = () => {
		if (started || scheduled) return;
		scheduled = true;
		// rAF runs before paint. Idle work (or a following task) gives the page a
		// chance to paint before either vendor starts downloading and executing.
		frame = browser.requestAnimationFrame(() => {
			frame = undefined;
			if (typeof browser.requestIdleCallback === "function") {
				idle = browser.requestIdleCallback(start, { timeout: 1000 });
			} else {
				timer = browser.setTimeout(start, 0);
			}
		});
	};
	// A slow resource or a background tab must not postpone automatic analytics
	// indefinitely. An early page exit also attempts startup with the queued visit.
	const deadline = browser.setTimeout(start, 2000);
	browser.addEventListener("pagehide", start, { once: true });
	if (browser.document.readyState === "complete") afterLoad();
	else browser.addEventListener("load", afterLoad, { once: true });
}

export function withdrawSiteAnalyticsConsent(browser: Window): void {
	controllers.get(browser)?.update(false);
}

/** One controller per document; permission changes and SPA routes update its lifecycle. */
export function startSiteAnalytics(options: SiteAnalyticsOptions): void {
	const existing = controllers.get(options.browser);
	if (existing) {
		existing.update(options.analyticsAllowed);
		return;
	}
	const browser = options.browser as AnalyticsWindow;
	const gaId = /^G-[A-Z0-9]+$/.test(options.googleAnalyticsId ?? "")
		? options.googleAnalyticsId
		: undefined;
	const clarityId = /^[a-z0-9]{6,32}$/.test(options.clarityProjectId ?? "")
		? options.clarityProjectId
		: undefined;
	if (!gaId && !clarityId) return;
	let allowed = false;
	let gaConfigured = false;
	let clarityConfigured = false;
	let clarityRunning = false;
	let clarityConsentGranted = false;
	let lastPage: string | undefined;
	const appended = new Set<string>();
	const scheduled = new Set<string>();
	const pending: Array<{ src: string; check: () => boolean; after?: () => void }> = [];
	let loading = false;
	const call = (command: Command | undefined, ...args: unknown[]) => {
		try {
			command?.(...args);
		} catch {
			/* Optional measurement must never interrupt work. */
		}
	};
	const permitted = () => allowed && !browserAnalyticsPrivacySignal();
	const replayAllowed = () => permitted() && clarityPageAllowed(new URL(browser.location.href));
	const drain = () => {
		if (loading || !pending.length) return;
		loading = true;
		scheduleTagLoading(browser, () => {
			const item = pending.shift()!;
			scheduled.delete(item.src);
			if (!item.check() || appended.has(item.src)) {
				loading = false;
				drain();
				return;
			}
			appended.add(item.src);
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				browser.clearTimeout(fallback);
				loading = false;
				drain();
			};
			const fallback = browser.setTimeout(finish, 2000);
			const script = browser.document.createElement("script");
			script.async = true;
			script.src = item.src;
			script.onload = () => {
				item.after?.();
				finish();
			};
			script.onerror = finish;
			browser.document.head.appendChild(script);
		});
	};
	const load = (src: string, check: () => boolean, after?: () => void) => {
		if (appended.has(src) || scheduled.has(src)) return;
		scheduled.add(src);
		pending.push({ src, check, after });
		drain();
	};
	const denyReplayCookies = () => {
		if (!clarityConfigured) return;
		call(browser.clarity, "consentv2", { analytics_Storage: "denied", ad_Storage: "denied" });
		clarityConsentGranted = false;
	};
	const stopReplay = (force = false) => {
		if (!clarityConfigured || (!clarityRunning && !force)) return;
		denyReplayCookies();
		call(browser.clarity, "stop");
		clarityRunning = false;
	};
	const restrictReplay = (force = false) => {
		if (browserAnalyticsPrivacySignal() || !clarityPageAllowed(new URL(browser.location.href)))
			stopReplay(force);
		// A normal withdrawal denies storage without stopping an already loaded SDK.
		else denyReplayCookies();
	};
	const track = () => {
		const url = new URL(browser.location.href);
		const gaAllowed = permitted() && publicAnalyticsPath(url) !== null;
		if (gaId) {
			browser[`ga-disable-${gaId}`] = !gaAllowed;
			if (gaAllowed) {
				browser.dataLayer ??= [];
				browser.gtag ??= function () {
					browser.dataLayer?.push(arguments);
				};
				const properties = {
					page_location: analyticsPageLocation(url),
					page_referrer: referrerOrigin(browser.document.referrer),
					page_title: "EzImageAI",
				};
				if (!gaConfigured) {
					gaConfigured = true;
					call(browser.gtag, "consent", "default", {
						analytics_storage: "denied",
						ad_storage: "denied",
						ad_user_data: "denied",
						ad_personalization: "denied",
					});
					call(browser.gtag, "js", new Date());
					call(browser.gtag, "config", gaId, {
						...properties,
						send_page_view: false,
						allow_google_signals: false,
						allow_ad_personalization_signals: false,
					});
				}
				call(browser.gtag, "consent", "update", {
					analytics_storage: "granted",
					ad_storage: "denied",
					ad_user_data: "denied",
					ad_personalization: "denied",
				});
				if (lastPage !== properties.page_location) {
					call(browser.gtag, "set", properties);
					call(browser.gtag, "event", "page_view", { ...properties, send_to: gaId });
					lastPage = properties.page_location;
				}
				load(
					`https://www.googletagmanager.com/gtag/js?id=${gaId}`,
					() => permitted() && publicAnalyticsPath(new URL(browser.location.href)) !== null,
				);
			} else {
				lastPage = undefined;
				if (gaConfigured)
					call(browser.gtag, "consent", "update", {
						analytics_storage: "denied",
						ad_storage: "denied",
						ad_user_data: "denied",
						ad_personalization: "denied",
					});
			}
		}
		if (clarityId && replayAllowed()) {
			browser.clarity ??= (...args: unknown[]) => {
				(browser.clarity!.q ??= []).push(args);
			};
			const wasConfigured = clarityConfigured;
			clarityConfigured = true;
			if (!clarityRunning) {
				if (wasConfigured) call(browser.clarity, "start");
				clarityRunning = true;
			}
			if (!clarityConsentGranted) {
				call(browser.clarity, "consentv2", { analytics_Storage: "granted", ad_Storage: "denied" });
				clarityConsentGranted = true;
			}
			load(`https://www.clarity.ms/tag/${clarityId}`, replayAllowed, () => {
				if (!replayAllowed()) restrictReplay(true);
			});
		} else restrictReplay();
	};
	controllers.set(browser, {
		update(value) {
			allowed = value;
			track();
		},
	});
	const history = browser.history;
	const wrap = (original: History["pushState"]): History["pushState"] =>
		function (data: unknown, title: string, destination?: string | URL | null) {
			if (destination != null) {
				const next = new URL(destination, browser.location.href);
				if (!clarityPageAllowed(next)) stopReplay();
				if (gaId && !publicAnalyticsPath(next)) browser[`ga-disable-${gaId}`] = true;
			}
			original.call(history, data, title, destination);
			track();
		};
	history.pushState = wrap(history.pushState.bind(history));
	history.replaceState = wrap(history.replaceState.bind(history));
	browser.addEventListener("popstate", track);
	browser.addEventListener("ezpic:growth-event", (event) => {
		if (!replayAllowed()) return;
		const detail = (event as CustomEvent).detail;
		const parsed = generationDiagnosticsSchema.safeParse(detail?.properties?.generation);
		if (
			["generation_input_observed", "generation_action_observed"].includes(detail?.name) &&
			parsed.success
		) {
			for (const [key, value] of Object.entries(parsed.data))
				call(browser.clarity, "set", `generation_${key}`, String(value));
			call(browser.clarity, "event", `${parsed.data.mediaKind}_${parsed.data.phase}`);
		} else {
			const name = (
				{
					editor_generation_confirmed: "image_submitted",
					editor_generation_succeeded: "image_succeeded",
					editor_generation_failed: "image_failed",
					source_upload_started: "image_upload_started",
					source_upload_completed: "image_upload_completed",
					result_downloaded: "image_downloaded",
					video_effect_submit: "video_effect_submitted",
					video_effect_ready_observed: "video_effect_succeeded",
					video_effect_failed_observed: "video_effect_failed",
				} as Record<string, string>
			)[detail?.name];
			if (name) call(browser.clarity, "event", name);
		}
	});
	controllers.get(browser)!.update(options.analyticsAllowed);
}
