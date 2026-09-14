export interface SiteAnalyticsOptions {
	browser: Window;
	googleAnalyticsId?: string;
	clarityProjectId?: string;
}

type AnalyticsCommand = (...args: unknown[]) => void;
type ClarityCommand = AnalyticsCommand & { q?: unknown[][] };
type AnalyticsWindow = Window & {
	dataLayer?: IArguments[];
	gtag?: AnalyticsCommand;
	clarity?: ClarityCommand;
} & Partial<Record<`ga-disable-${string}`, boolean>>;

const initializedDocuments = new WeakSet<Window>();
const publicPages = new Set([
	"/",
	"/pricing",
	"/blog",
	"/docs",
	"/privacy",
	"/terms",
	"/contact",
	"/changelog",
]);

function publicPage(url: URL): boolean {
	const pathname = url.pathname.replace(/\/$/, "") || "/";
	return publicPages.has(pathname) || /^\/(?:blog|docs)(?:\/[a-z0-9][a-z0-9-]*)+$/i.test(pathname);
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

export function startSiteAnalytics(options: SiteAnalyticsOptions): void {
	const browser = options.browser as AnalyticsWindow;
	if (initializedDocuments.has(browser)) return;
	const document = browser.document;
	const gaId = /^G-[A-Z0-9]+$/.test(options.googleAnalyticsId ?? "")
		? options.googleAnalyticsId
		: undefined;
	const clarityId = /^[a-z0-9]{6,32}$/.test(options.clarityProjectId ?? "")
		? options.clarityProjectId
		: undefined;
	if (!gaId && !clarityId) return;
	initializedDocuments.add(browser);
	const scriptSources: string[] = [];
	const appendScript = (src: string) => {
		const script = document.createElement("script");
		script.async = true;
		script.src = src;
		document.head.appendChild(script);
	};

	if (gaId) {
		let lastPage: string | undefined;
		const callGa = (...args: unknown[]) => {
			try {
				browser.gtag?.(...args);
			} catch {
				/* Analytics must not interrupt navigation. */
			}
		};
		const propertiesFor = (url: URL) => ({
			page_location: `${url.origin}${publicPage(url) ? url.pathname : "/"}`,
			page_referrer: referrerOrigin(document.referrer),
			page_title: "EzPic",
		});
		const trackPage = () => {
			const url = new URL(browser.location.href);
			const allowed = publicPage(url);
			browser[`ga-disable-${gaId}`] = !allowed;
			if (!allowed) {
				lastPage = undefined;
				return;
			}
			const properties = propertiesFor(url);
			callGa("set", properties);
			if (lastPage !== properties.page_location) {
				callGa("event", "page_view", { ...properties, send_to: gaId });
				lastPage = properties.page_location;
			}
		};
		const initialUrl = new URL(browser.location.href);
		browser[`ga-disable-${gaId}`] = !publicPage(initialUrl);
		browser.dataLayer ??= [];
		browser.gtag ??= function () {
			browser.dataLayer?.push(arguments);
		};
		callGa("js", new Date());
		callGa("config", gaId, {
			...propertiesFor(initialUrl),
			send_page_view: false,
			allow_google_signals: false,
			allow_ad_personalization_signals: false,
		});
		scriptSources.push(`https://www.googletagmanager.com/gtag/js?id=${gaId}`);
		// GA retains its existing public-page scope; Clarity owns its normal SPA lifecycle.
		const history = browser.history;
		const wrapHistory = (original: History["pushState"]): History["pushState"] =>
			function (data: unknown, title: string, url?: string | URL | null) {
				if (url != null)
					browser[`ga-disable-${gaId}`] = !publicPage(new URL(url, browser.location.href));
				original.call(history, data, title, url);
				trackPage();
			};
		history.pushState = wrapHistory(history.pushState.bind(history));
		history.replaceState = wrapHistory(history.replaceState.bind(history));
		browser.addEventListener("popstate", trackPage);
		trackPage();
	}
	if (clarityId) {
		browser.clarity ??= (...args: unknown[]) => {
			(browser.clarity!.q ??= []).push(args);
		};
		scriptSources.push(`https://www.clarity.ms/tag/${clarityId}`);
	}
	// Install queues and navigation tracking now, then load the vendors after the
	// initial rendering work. Public visits during this wait retain their own URL.
	scheduleTagLoading(browser, () => scriptSources.forEach(appendScript));
	// Tags live for the document lifetime, so React remounts must not reload or stop them.
}
