import { describe, expect, it, vi } from "vitest";

import { startSiteAnalytics } from "./site-analytics";

function harness(initialUrl = "https://ezimageai.com/", cookie = "") {
	let url = new URL(initialUrl);
	const scripts: Array<{ src: string; onload?: () => void; onerror?: () => void }> = [];
	const gtag = vi.fn();
	const clarity = vi.fn();
	const events = new EventTarget();
	const frames = new Map<number, FrameRequestCallback>();
	const idleCallbacks = new Map<number, IdleRequestCallback>();
	const timers = new Map<number, () => void>();
	let callbackId = 0;
	const move = (_data: unknown, _title: string, destination?: string | URL | null) => {
		if (destination != null) url = new URL(destination, url);
	};
	const browser = {
		get location() {
			return url;
		},
		document: {
			readyState: "loading",
			cookie,
			referrer: "https://www.google.com/",
			createElement: () => ({ src: "" }),
			head: { appendChild: (script: (typeof scripts)[number]) => scripts.push(script) },
		},
		history: { pushState: move, replaceState: move },
		gtag,
		clarity,
		addEventListener: vi.fn(events.addEventListener.bind(events)),
		removeEventListener: events.removeEventListener.bind(events),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++callbackId, callback);
			return callbackId;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		requestIdleCallback: (callback: IdleRequestCallback) => {
			idleCallbacks.set(++callbackId, callback);
			return callbackId;
		},
		cancelIdleCallback: (id: number) => idleCallbacks.delete(id),
		setTimeout: (callback: () => void) => {
			timers.set(++callbackId, callback);
			return callbackId;
		},
		clearTimeout: (id: number) => timers.delete(id),
	};
	const paint = () => {
		for (const [id, callback] of [...frames]) {
			frames.delete(id);
			callback(16);
		}
	};
	const idle = () => {
		for (const [id, callback] of [...idleCallbacks]) {
			idleCallbacks.delete(id);
			callback({ didTimeout: false, timeRemaining: () => 10 });
		}
	};
	const loaded = () => {
		browser.document.readyState = "complete";
		events.dispatchEvent(new Event("load"));
	};
	const finishLoading = () => {
		loaded();
		paint();
		idle();
		scripts[0]?.onload?.();
		paint();
		idle();
	};
	const runTimers = () => {
		for (const [id, callback] of [...timers]) {
			timers.delete(id);
			callback();
		}
	};
	const start = () =>
		startSiteAnalytics({
			browser: browser as unknown as Window,
			googleAnalyticsId: "G-TEST123456",
			clarityProjectId: "testproject1",
		});
	return {
		browser,
		scripts,
		gtag,
		clarity,
		start,
		loaded,
		paint,
		idle,
		finishLoading,
		runTimers,
		events,
	};
}

describe("automatic website analytics", () => {
	it("queues visits immediately and gives rendering a turn between vendor executions", () => {
		const app = harness("https://ezimageai.com/?token=private-token");
		app.start();
		expect(app.scripts).toHaveLength(0);
		expect(app.gtag).toHaveBeenCalledWith(
			"event",
			"page_view",
			expect.objectContaining({
				page_location: "https://ezimageai.com/",
			}),
		);
		app.browser.history.pushState({}, "", "/pricing");
		expect(app.gtag.mock.calls.filter(([command]) => command === "event")).toHaveLength(2);
		app.loaded();
		expect(app.scripts).toHaveLength(0);
		app.paint();
		expect(app.scripts).toHaveLength(0);
		app.idle();
		expect(app.scripts).toHaveLength(1);
		app.scripts[0]?.onload?.();
		expect(app.scripts).toHaveLength(1);
		app.paint();
		app.idle();
		expect(app.scripts).toHaveLength(2);
		expect(JSON.stringify(app.gtag.mock.calls)).not.toContain("private-token");
	});
	it("loads after paint when hydration starts on an already loaded page", () => {
		const app = harness();
		app.loaded();
		app.start();
		expect(app.scripts).toHaveLength(0);
		app.paint();
		app.idle();
		expect(app.scripts).toHaveLength(1);
		app.scripts[0]?.onload?.();
		app.paint();
		app.idle();
		expect(app.scripts).toHaveLength(2);
	});
	it("uses a timer when idle callbacks are unavailable", () => {
		const app = harness();
		Reflect.deleteProperty(app.browser, "requestIdleCallback");
		app.start();
		app.loaded();
		app.paint();
		expect(app.scripts).toHaveLength(0);
		app.runTimers();
		app.runTimers();
		expect(app.scripts).toHaveLength(2);
	});
	it("bounds the wait when load or animation frames stall", () => {
		const app = harness();
		app.start();
		expect(app.scripts).toHaveLength(0);
		app.runTimers();
		app.runTimers();
		expect(app.scripts).toHaveLength(2);
		app.finishLoading();
		app.start();
		expect(app.scripts).toHaveLength(2);
	});
	it("continues after a blocked first vendor and does not append scripts twice", () => {
		const app = harness();
		app.start();
		app.loaded();
		app.paint();
		app.idle();
		expect(app.scripts).toHaveLength(1);
		app.scripts[0]?.onerror?.();
		app.paint();
		app.idle();
		expect(app.scripts).toHaveLength(2);
		app.runTimers();
		app.events.dispatchEvent(new Event("pagehide"));
		expect(app.scripts).toHaveLength(2);
	});
	it("attempts startup before an early page exit without loading twice", () => {
		const app = harness();
		app.start();
		expect(app.scripts).toHaveLength(0);
		app.events.dispatchEvent(new Event("pagehide"));
		expect(app.scripts).toHaveLength(2);
		app.finishLoading();
		app.runTimers();
		expect(app.scripts).toHaveLength(2);
	});
	it.each(["", "consent=false", "consent=true"])(
		"loads both services without waiting for consent (%s)",
		(cookie) => {
			const app = harness("https://ezimageai.com/", cookie);
			app.start();
			app.finishLoading();
			expect(app.scripts.map(({ src }) => src)).toEqual([
				"https://www.googletagmanager.com/gtag/js?id=G-TEST123456",
				"https://www.clarity.ms/tag/testproject1",
			]);
			expect(app.gtag.mock.calls.some(([command]) => command === "consent")).toBe(false);
			expect(app.clarity.mock.calls.some(([command]) => command === "consentv2")).toBe(false);
		},
	);
	it.each([
		"/login",
		"/try?token=test#preview",
		"/history/private-job",
		"/settings/billing",
		"/admin/users",
	])("loads the standard Clarity integration on %s", (pathname) => {
		const app = harness(`https://ezimageai.com${pathname}`, "consent=false");
		app.browser.document.referrer = "https://ezimageai.com/login?token=test";
		app.start();
		app.finishLoading();
		expect(app.scripts.map(({ src }) => src)).toContain("https://www.clarity.ms/tag/testproject1");
	});
	it("keeps replay running across page navigation, including private routes", () => {
		const app = harness();
		app.start();
		app.browser.history.pushState({}, "", "/history/private-job?token=test");
		app.browser.history.replaceState({}, "", "/pricing");
		app.finishLoading();
		expect(app.clarity).not.toHaveBeenCalledWith("stop");
		expect(app.browser.addEventListener.mock.calls.map(([name]) => name)).not.toContain("click");
		expect(app.browser.addEventListener.mock.calls.map(([name]) => name)).not.toContain("submit");
		expect(app.scripts).toHaveLength(2);
	});
	it("preserves GA address redaction and public-page measurement", () => {
		const app = harness("https://ezimageai.com/?token=private-token&prompt=private-text");
		app.start();
		expect(app.gtag).toHaveBeenCalledWith(
			"event",
			"page_view",
			expect.objectContaining({
				page_location: "https://ezimageai.com/",
				page_referrer: "https://www.google.com/",
			}),
		);
		expect(JSON.stringify(app.gtag.mock.calls)).not.toMatch(/private-token|private-text/);
		app.browser.history.pushState({}, "", "/history/private-job");
		expect(app.browser).toHaveProperty("ga-disable-G-TEST123456", true);
		expect(app.gtag.mock.calls.filter(([command]) => command === "event")).toHaveLength(1);
	});
	it("initializes once per document without duplicate scripts or page views", () => {
		const app = harness();
		app.start();
		app.start();
		app.browser.history.replaceState({}, "", "/");
		app.browser.history.pushState({}, "", "/pricing");
		app.browser.history.replaceState({}, "", "/pricing");
		app.finishLoading();
		expect(app.scripts).toHaveLength(2);
		expect(app.gtag.mock.calls.filter(([command]) => command === "event")).toHaveLength(2);
	});
	it("allows the normal Clarity startup queue to run after a navigation", () => {
		const app = harness();
		const browser = app.browser as unknown as Window & {
			clarity?: ((...args: unknown[]) => void) & { q?: unknown[][] };
		};
		Reflect.deleteProperty(browser, "clarity");
		app.start();
		app.browser.history.pushState({}, "", "/history/private-job");
		browser.clarity?.("start", { projectId: "testproject1" });
		expect(browser.clarity?.q?.some(([command]) => command === "start")).toBe(true);
	});
});
