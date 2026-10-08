import {
	createBrowserGrowthAnalyticsDispatcher,
	createGrowthContentAttributionStore,
	clearBrowserGrowthContentAttribution,
	readBrowserGrowthContentAttribution,
	setBrowserGrowthContentAttribution,
	trackBrowserGrowthEvent,
} from "@repo/utils/lib/growth-analytics";
import { createLazyBrowserGrowthTracker } from "@repo/utils/lib/growth-analytics-browser";
import {
	hasGrowthAnalyticsConsent,
	readGrowthAnalyticsSessionHash,
} from "@repo/utils/lib/growth-analytics-cookie";
import { describe, expect, it, vi } from "vitest";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const event = { name: "source_upload_started", properties: { status: "started" } };

describe("homepage growth analytics module boundary", () => {
	it.each(["", "false"])(
		"does not load or retain old optional context before consent=%s",
		async (consent) => {
			const load = vi.fn();
			const clear = vi.fn();
			const track = createLazyBrowserGrowthTracker({
				cookie: () => `consent=${consent}`,
				load,
				active: () => undefined,
				clearUnconsented: clear,
			});
			expect(await track(event)).toBe("blocked");
			expect(load).not.toHaveBeenCalled();
			expect(clear).toHaveBeenCalledOnce();
		},
	);

	it("preserves explicit click context and parameters when deferring the original dispatcher", async () => {
		const send = vi.fn();
		const original = createBrowserGrowthAnalyticsDispatcher({
			getCookie: () => "consent=true",
			dispatch: send,
		});
		const wait = deferred<{ trackBrowserGrowthEvent: typeof original.track }>();
		const track = createLazyBrowserGrowthTracker({
			cookie: () => "consent=true",
			load: () => wait.promise,
			active: () => undefined,
			clearUnconsented: vi.fn(),
		});
		const context = {
			source_blog_id: "photo-ideas",
			internal_source: "blog" as const,
			entry_path: "/blog/photo-ideas",
		};
		const options = {
			dedupeKey: "upload-click",
			attribution: { enabled: true, context, capturedAt: Date.now() },
		};
		const pending = track(event, options);
		wait.resolve({ trackBrowserGrowthEvent: (input, options) => original.track(input, options) });
		expect(await pending).toBe("sent");
		expect(send.mock.calls[0]?.[1]).toMatchObject({
			...event,
			properties: { ...event.properties, ...context },
		});
		expect(await track(event, options)).toBe("duplicate");
	});

	it("a page selected during loading cannot donate its context to an earlier generic click", async () => {
		const attribution = createGrowthContentAttributionStore({ hasConsent: () => true });
		const send = vi.fn();
		const original = createBrowserGrowthAnalyticsDispatcher({
			getCookie: () => "consent=true",
			dispatch: send,
			attribution,
		});
		const wait = deferred<{ trackBrowserGrowthEvent: typeof original.track }>();
		const track = createLazyBrowserGrowthTracker({
			cookie: () => "consent=true",
			load: () => wait.promise,
			active: () => undefined,
			clearUnconsented: vi.fn(),
		});
		const pending = track(event, { dedupeKey: "early-click" });
		attribution.set({
			source_blog_id: "later-page",
			internal_source: "blog",
			entry_path: "/blog/later-page",
		});
		wait.resolve({ trackBrowserGrowthEvent: (input, options) => original.track(input, options) });
		expect(await pending).toBe("sent");
		expect(send.mock.calls[0]?.[1]).toEqual(event);
	});

	it("withdrawal during loading is rechecked by the actual dispatcher before any external send", async () => {
		let cookie = "consent=true";
		const external = vi.fn();
		const send = vi.fn();
		const original = createBrowserGrowthAnalyticsDispatcher({
			getCookie: () => cookie,
			dispatch: send,
			sendExternal: external,
		});
		const wait = deferred<{ trackBrowserGrowthEvent: typeof original.track }>();
		const track = createLazyBrowserGrowthTracker({
			cookie: () => cookie,
			load: () => wait.promise,
			active: () => undefined,
			clearUnconsented: vi.fn(),
		});
		const pending = track(event);
		cookie = "consent=false";
		wait.resolve({ trackBrowserGrowthEvent: (input, options) => original.track(input, options) });
		expect(await pending).toBe("blocked");
		expect(external).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("continues using already-loaded context and strict sensitive-data rejection", async () => {
		const attribution = createGrowthContentAttributionStore({ hasConsent: () => true });
		attribution.set({
			source_blog_id: "existing-page",
			internal_source: "blog",
			entry_path: "/blog/existing-page",
		});
		const send = vi.fn();
		const original = createBrowserGrowthAnalyticsDispatcher({
			getCookie: () => "consent=true",
			dispatch: send,
			attribution,
		});
		const load = vi.fn();
		const track = createLazyBrowserGrowthTracker({
			cookie: () => "consent=true",
			load,
			active: () => ({
				trackBrowserGrowthEvent: (input, options) => original.track(input, options),
			}),
			clearUnconsented: vi.fn(),
		});
		expect(await track(event)).toBe("sent");
		expect(send.mock.calls[0]?.[1]?.properties.source_blog_id).toBe("existing-page");
		expect(await track({ ...event, properties: { prompt: "private prompt" } })).toBe("rejected");
		expect(load).not.toHaveBeenCalled();
	});

	it("reaccepting consent cannot revive an event from before withdrawal", async () => {
		let revision = 0;
		const send = vi.fn();
		const wait = deferred<{ trackBrowserGrowthEvent: typeof send }>();
		const track = createLazyBrowserGrowthTracker({
			cookie: () => "consent=true",
			load: () => wait.promise,
			active: () => undefined,
			clearUnconsented: vi.fn(),
			revision: () => revision,
		});
		const pending = track(event);
		revision++;
		wait.resolve({ trackBrowserGrowthEvent: send });
		expect(await pending).toBe("blocked");
		expect(send).not.toHaveBeenCalled();
	});

	it("a delayed real landing_viewed cannot clear the next page's active content", async () => {
		const stored = new Map<string, string>();
		const location = { pathname: "/", protocol: "https:" };
		vi.stubGlobal("location", location);
		vi.stubGlobal("document", { cookie: "consent=true" });
		const dispatch = vi.fn();
		vi.stubGlobal("window", {
			sessionStorage: {
				getItem: (key: string) => stored.get(key) ?? null,
				setItem: (key: string, value: string) => stored.set(key, value),
				removeItem: (key: string) => stored.delete(key),
			},
			dispatchEvent: dispatch,
		});
		try {
			clearBrowserGrowthContentAttribution();
			const wait = deferred<{ trackBrowserGrowthEvent: typeof trackBrowserGrowthEvent }>();
			const track = createLazyBrowserGrowthTracker({
				cookie: () => "consent=true",
				load: () => wait.promise,
				active: () => undefined,
				clearUnconsented: vi.fn(),
				page: () => location.pathname,
			});
			const pending = track({ name: "landing_viewed", properties: { status: "viewed" } });
			location.pathname = "/blog/later-page";
			const context = {
				source_blog_id: "later-page",
				internal_source: "blog" as const,
				entry_path: "/blog/later-page",
			};
			expect(setBrowserGrowthContentAttribution(context)).toBe(true);
			wait.resolve({ trackBrowserGrowthEvent });
			expect(await pending).toBe("blocked");
			expect(readBrowserGrowthContentAttribution()).toEqual(context);
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			clearBrowserGrowthContentAttribution();
			vi.unstubAllGlobals();
		}
	});

	it("freezes mutable event, options, and explicit click attribution before waiting", async () => {
		const send = vi.fn().mockResolvedValue("sent");
		const wait = deferred<{ trackBrowserGrowthEvent: typeof send }>();
		const track = createLazyBrowserGrowthTracker({
			cookie: () => "consent=true",
			load: () => wait.promise,
			active: () => undefined,
			clearUnconsented: vi.fn(),
		});
		const input = { name: "source_upload_started", properties: { status: "started" } };
		const options = {
			dedupeKey: "original",
			attribution: {
				enabled: true,
				context: {
					source_blog_id: "original-page",
					internal_source: "blog",
					entry_path: "/blog/original-page",
				},
				capturedAt: Date.now(),
			},
		};
		const pending = track(input, options as Parameters<typeof track>[1]);
		input.properties.status = "changed";
		options.dedupeKey = "changed";
		options.attribution.context.source_blog_id = "changed-page";
		wait.resolve({ trackBrowserGrowthEvent: send });
		expect(await pending).toBe("sent");
		expect(send).toHaveBeenCalledWith(
			{ name: "source_upload_started", properties: { status: "started" } },
			expect.objectContaining({
				dedupeKey: "original",
				attribution: expect.objectContaining({
					context: expect.objectContaining({ source_blog_id: "original-page" }),
				}),
			}),
		);
	});

	it("a stalled chunk cannot block handoff or dispatch its old event after timeout", async () => {
		vi.useFakeTimers();
		try {
			const send = vi.fn();
			const wait = deferred<{ trackBrowserGrowthEvent: typeof send }>();
			const track = createLazyBrowserGrowthTracker({
				cookie: () => "consent=true",
				load: () => wait.promise,
				active: () => undefined,
				clearUnconsented: vi.fn(),
			});
			const pending = track(event);
			await vi.advanceTimersByTimeAsync(1_500);
			expect(await pending).toBe("failed");
			wait.resolve({ trackBrowserGrowthEvent: send });
			await Promise.resolve();
			expect(send).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("failed optional loading does not reject an upload flow", async () => {
		const track = createLazyBrowserGrowthTracker({
			cookie: () => "consent=true",
			load: async () => {
				throw new Error("offline");
			},
			active: () => undefined,
			clearUnconsented: vi.fn(),
		});
		await expect(track(event)).resolves.toBe("failed");
	});

	it("keeps original exact consent and one-way session cookie parsing", () => {
		expect(hasGrowthAnalyticsConsent("xconsent=true; consent=false")).toBe(false);
		expect(hasGrowthAnalyticsConsent("other=1; consent=true")).toBe(true);
		const hash = `sha256:${"a".repeat(64)}`;
		expect(
			readGrowthAnalyticsSessionHash(`ezpic_analytics_session=${encodeURIComponent(hash)}`),
		).toBe(hash);
		expect(readGrowthAnalyticsSessionHash("ezpic_analytics_session=%bad")).toBeUndefined();
		expect(
			readGrowthAnalyticsSessionHash(`ezpic_analytics_session=${hash}private`),
		).toBeUndefined();
	});
});
