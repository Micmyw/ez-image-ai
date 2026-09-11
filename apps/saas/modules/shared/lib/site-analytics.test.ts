import { describe, expect, it, vi } from "vitest";

import { startSiteAnalytics } from "./site-analytics";

function harness(initialUrl = "https://ezimageai.com/", cookie = "") {
	let url = new URL(initialUrl);
	const scripts: Array<{ src: string }> = [];
	const gtag = vi.fn();
	const clarity = vi.fn();
	const move = (_data: unknown, _title: string, destination?: string | URL | null) => {
		if (destination != null) url = new URL(destination, url);
	};
	const browser = {
		get location() {
			return url;
		},
		document: {
			cookie,
			referrer: "https://www.google.com/",
			createElement: () => ({ src: "" }),
			head: { appendChild: (script: (typeof scripts)[number]) => scripts.push(script) },
		},
		history: { pushState: move, replaceState: move },
		gtag,
		clarity,
		addEventListener: vi.fn(),
	};
	const start = () =>
		startSiteAnalytics({
			browser: browser as unknown as Window,
			googleAnalyticsId: "G-TEST123456",
			clarityProjectId: "testproject1",
		});
	return { browser, scripts, gtag, clarity, start };
}

describe("automatic website analytics", () => {
	it.each(["", "consent=false", "consent=true"])(
		"loads both services without waiting for consent (%s)",
		(cookie) => {
			const app = harness("https://ezimageai.com/", cookie);
			app.start();
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
		expect(app.scripts.map(({ src }) => src)).toContain("https://www.clarity.ms/tag/testproject1");
	});
	it("keeps replay running across page navigation, including private routes", () => {
		const app = harness();
		app.start();
		app.browser.history.pushState({}, "", "/history/private-job?token=test");
		app.browser.history.replaceState({}, "", "/pricing");
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
