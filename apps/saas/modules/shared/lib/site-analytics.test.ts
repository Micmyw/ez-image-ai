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
	const start = (analyticsAllowed = true) =>
		startSiteAnalytics({
			browser: browser as unknown as Window,
			analyticsAllowed,
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

describe("consent-controlled website analytics", () => {
	it("loads no vendors until permission resolves and sends analytics-only consent", () => {
		const app = harness();
		app.start(false);
		app.finishLoading();
		app.runTimers();
		expect(app.scripts).toHaveLength(0);
		expect(app.gtag).not.toHaveBeenCalled();
		expect(app.clarity).not.toHaveBeenCalled();
		app.start(true);
		app.finishLoading();
		expect(app.scripts).toHaveLength(2);
		expect(app.clarity).toHaveBeenCalledWith("consentv2", {
			analytics_Storage: "granted",
			ad_Storage: "denied",
		});
	});
	it("cancels deferred loads after refusal", () => {
		const app = harness();
		app.start();
		app.start(false);
		app.finishLoading();
		app.runTimers();
		expect(app.scripts).toHaveLength(0);
		expect(app.clarity).toHaveBeenLastCalledWith("consentv2", {
			analytics_Storage: "denied",
			ad_Storage: "denied",
		});
		expect(app.clarity).not.toHaveBeenCalledWith("stop");
	});
	it("withdraws consent without stopping the SDK and restores consent without restarting it", () => {
		const app = harness();
		app.start();
		app.finishLoading();
		app.start(false);
		expect(app.clarity).toHaveBeenCalledWith("consentv2", {
			analytics_Storage: "denied",
			ad_Storage: "denied",
		});
		expect(app.clarity).not.toHaveBeenCalledWith("stop");
		expect(app.browser).toHaveProperty("ga-disable-G-TEST123456", true);
		app.start(true);
		app.finishLoading();
		expect(app.scripts).toHaveLength(2);
		expect(app.clarity).not.toHaveBeenCalledWith("start");
		expect(app.clarity).toHaveBeenLastCalledWith("consentv2", {
			analytics_Storage: "granted",
			ad_Storage: "denied",
		});
	});
	it("keeps a late-loading SDK under denied consent after withdrawal", () => {
		const app = harness();
		app.start();
		app.finishLoading();
		app.start(false);
		app.scripts.find((script) => script.src.includes("clarity"))?.onload?.();
		expect(app.clarity).toHaveBeenLastCalledWith("consentv2", {
			analytics_Storage: "denied",
			ad_Storage: "denied",
		});
		expect(app.clarity).not.toHaveBeenCalledWith("stop");
	});
	it("still stops on private navigation after withdrawal and on a late script load", () => {
		const app = harness();
		app.start();
		app.finishLoading();
		app.start(false);
		app.browser.history.pushState({}, "", "/admin/analytics");
		expect(app.clarity).toHaveBeenLastCalledWith("stop");
		app.clarity.mockClear();
		app.scripts.find((script) => script.src.includes("clarity"))?.onload?.();
		expect(app.clarity).toHaveBeenLastCalledWith("stop");
		app.browser.history.pushState({}, "", "/create");
		expect(app.clarity).not.toHaveBeenCalledWith("start");
	});
	it("still stops recording when a browser privacy signal becomes active", () => {
		const app = harness();
		app.start();
		app.finishLoading();
		vi.stubGlobal("navigator", { globalPrivacyControl: true });
		try {
			app.start(false);
			expect(app.clarity).toHaveBeenLastCalledWith("stop");
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it.each([
		"/login",
		"/settings/billing",
		"/admin/users",
		"/history/job",
		"/create?token=secret",
		"/create?prompt=secret",
		"/create#private",
	])("excludes replay on %s", (path) => {
		const app = harness(`https://ezimageai.com${path}`);
		app.start();
		app.finishLoading();
		expect(app.scripts.some((s) => s.src.includes("clarity"))).toBe(false);
	});
	it.each([
		"/",
		"/create",
		"/create?mode=video",
		"/create?videoJob=opaque-task",
		"/video/effects/rumpelstiltskin",
	])("includes generation workspace %s", (path) => {
		const app = harness(`https://ezimageai.com${path}`);
		app.start();
		app.finishLoading();
		expect(app.scripts.some((s) => s.src.includes("clarity"))).toBe(true);
	});
	it("stops before private navigation and resumes on returning to the editor", () => {
		const app = harness();
		app.start();
		app.finishLoading();
		app.browser.history.pushState({}, "", "/admin/analytics");
		expect(app.clarity).toHaveBeenLastCalledWith("stop");
		app.browser.history.pushState({}, "", "/create?mode=video");
		expect(app.clarity).toHaveBeenCalledWith("start");
		app.finishLoading();
		expect(app.scripts).toHaveLength(2);
	});
	it("preserves ChatGPT UTM in GA while removing private URL state", () => {
		const app = harness(
			"https://ezimageai.com/create?utm_source=chatgpt.com&job=private-job&prompt=private-text#secret",
		);
		app.start();
		expect(app.gtag).toHaveBeenCalledWith(
			"event",
			"page_view",
			expect.objectContaining({
				page_location: "https://ezimageai.com/create?utm_source=chatgpt.com",
				page_referrer: "https://www.google.com/",
			}),
		);
		expect(JSON.stringify(app.gtag.mock.calls)).not.toMatch(/private-job|private-text|#secret/);
	});
	it("rejects unsafe UTM for replay and sanitizes it for GA", () => {
		const app = harness("https://ezimageai.com/?utm_source=private%40example.com");
		app.start();
		app.finishLoading();
		expect(app.scripts.some((s) => s.src.includes("clarity"))).toBe(false);
		expect(JSON.stringify(app.gtag.mock.calls)).not.toContain("private");
	});
	it("defers tags until after paint and bounds a stalled idle callback", () => {
		const app = harness();
		app.start();
		expect(app.scripts).toHaveLength(0);
		app.loaded();
		app.paint();
		expect(app.scripts).toHaveLength(0);
		app.idle();
		expect(app.scripts).toHaveLength(1);
		app.scripts[0]?.onload?.();
		app.paint();
		app.idle();
		expect(app.scripts).toHaveLength(2);
		const delayed = harness();
		delayed.start();
		for (let i = 0; i < 4; i++) delayed.runTimers();
		expect(delayed.scripts).toHaveLength(2);
	});
	it("deduplicates remounts and repeated page observations", () => {
		const app = harness();
		app.start();
		app.start();
		app.browser.history.replaceState({}, "", "/");
		app.browser.history.pushState({}, "", "/pricing");
		app.finishLoading();
		expect(app.scripts).toHaveLength(2);
		expect(app.gtag.mock.calls.filter((c) => c[0] === "event")).toHaveLength(2);
	});
	it("forwards allowed generation buckets without raw inputs or task identity", () => {
		const app = harness();
		app.start();
		const send = (detail: unknown) => {
			const event = new Event("ezpic:growth-event");
			Object.assign(event, { detail });
			app.events.dispatchEvent(event);
		};
		send({
			name: "generation_input_observed",
			properties: {
				generation: { mediaKind: "video", phase: "editing", textLength: "51-200", inputCount: 1 },
				anonymousSessionHash: "private-id",
			},
		});
		expect(app.clarity).toHaveBeenCalledWith("set", "generation_textLength", "51-200");
		expect(app.clarity).toHaveBeenCalledWith("event", "video_editing");
		expect(JSON.stringify(app.clarity.mock.calls)).not.toContain("private-id");
		app.clarity.mockClear();
		send({
			name: "generation_input_observed",
			properties: {
				generation: { mediaKind: "video", phase: "editing", prompt: "private prompt" },
			},
		});
		expect(app.clarity).not.toHaveBeenCalled();
		app.start(false);
		app.clarity.mockClear();
		send({ name: "editor_generation_succeeded" });
		expect(app.clarity).not.toHaveBeenCalled();
	});
});
