import { ATTRIBUTION_COOKIE_NAME } from "@repo/utils/lib/acquisition-attribution-core";
import { describe, expect, it, vi } from "vitest";

import { createLazyPurchaseAttribution } from "./purchase-attribution";
import {
	createPurchaseAttribution,
	type AttributionRuntime,
} from "./purchase-attribution-controller";
import { CHECKOUT_TRIGGER_STORAGE_KEY, IDENTITY_STORAGE_KEY } from "./purchase-attribution-storage";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const module = { createPurchaseAttribution };

function harness(consent = "true", load = vi.fn(async () => module)) {
	let url = new URL("https://ezimageai.com/blog/portrait?utm_source=google&token=private#private");
	const cookies = new Map([["consent", consent]]);
	const stored = new Map<string, string>();
	const runtime: AttributionRuntime = {
		location: () => url,
		referrer: () => "https://www.google.com/search?token=private",
		cookie: () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
		writeCookie: (value) => {
			const pair = value.split(";")[0]!;
			const separator = pair.indexOf("=");
			if (value.includes("Max-Age=0")) cookies.delete(pair.slice(0, separator));
			else cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
		},
		storage: {
			getItem: (key) => stored.get(key) ?? null,
			setItem: (key, value) => stored.set(key, value),
			removeItem: (key) => stored.delete(key),
		},
		now: () => new Date("2026-10-08T10:00:00Z"),
	};
	return {
		controller: createLazyPurchaseAttribution(runtime, load),
		cookies,
		stored,
		runtime,
		load,
		navigate: (path: string) => {
			url = new URL(path, url);
		},
		firstTouch: () =>
			JSON.parse(decodeURIComponent(cookies.get(ATTRIBUTION_COOKIE_NAME) ?? "null")),
	};
}

describe("consent gated purchase attribution loading", () => {
	it.each(["", "false"])(
		"does not load optional attribution before consent=%s",
		async (consent) => {
			const app = harness(consent);
			await app.controller.captureFirstTouch();
			app.controller.captureTrigger();
			expect(await app.controller.checkoutAttribution(async () => ({ id: "a" }))).toBeUndefined();
			expect(app.load).not.toHaveBeenCalled();
			expect(app.firstTouch()).toBeNull();
			expect(app.stored.size).toBe(0);
		},
	);

	it("keeps the first safe landing in memory while awaiting consent and module loading", async () => {
		const wait = deferred<typeof module>();
		const app = harness(
			"",
			vi.fn(() => wait.promise),
		);
		await app.controller.captureFirstTouch();
		app.navigate("/pricing?utm_source=other");
		app.cookies.set("consent", "true");
		let ready = false;
		const capture = app.controller.captureFirstTouch().then(() => {
			ready = true;
		});
		await Promise.resolve();
		expect(ready).toBe(false);
		wait.resolve(module);
		await capture;
		expect(app.firstTouch()).toMatchObject({
			landingPath: "/blog/portrait",
			utmSource: "google",
			referrerOrigin: "https://www.google.com",
		});
		expect(JSON.stringify(app.firstTouch())).not.toMatch(/private|token|\?|#/);
	});

	it("preserves a rapid actual content click through pricing before the controller loads", async () => {
		const wait = deferred<typeof module>();
		const app = harness(
			"true",
			vi.fn(() => wait.promise),
		);
		const capture = app.controller.captureFirstTouch();
		app.controller.captureTrigger();
		app.navigate("/pricing?plan=ultimate");
		app.controller.captureTrigger();
		wait.resolve(module);
		await capture;
		expect(await app.controller.checkoutAttribution(async () => ({ id: "a" }))).toEqual({
			triggerPath: "/blog/portrait",
		});
		expect(JSON.parse(app.stored.get(CHECKOUT_TRIGGER_STORAGE_KEY)!)).toMatchObject({
			path: "/blog/portrait",
			ownerId: "a",
		});
	});

	it("withdrawal invalidates a pending import even if consent is accepted again", async () => {
		const old = deferred<typeof module>();
		const fresh = deferred<typeof module>();
		const app = harness(
			"true",
			vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise),
		);
		const original = app.controller.captureFirstTouch();
		app.controller.captureTrigger();
		app.cookies.set("consent", "false");
		app.controller.withdraw();
		app.navigate("/pricing");
		app.cookies.set("consent", "true");
		const current = app.controller.captureFirstTouch();
		const acceptedCookie = app.cookies.get(ATTRIBUTION_COOKIE_NAME);
		old.resolve(module);
		await original;
		expect(app.cookies.get(ATTRIBUTION_COOKIE_NAME)).toBe(acceptedCookie);
		expect(app.stored.has(CHECKOUT_TRIGGER_STORAGE_KEY)).toBe(false);
		fresh.resolve(module);
		await current;
		expect(await app.controller.checkoutAttribution(async () => ({ id: "a" }))).toEqual({
			triggerPath: "/pricing",
		});
	});

	it("logout prevents a late import from restoring the previous acquisition or click", async () => {
		const old = deferred<typeof module>();
		const app = harness("true", vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(module));
		const original = app.controller.captureFirstTouch();
		app.controller.captureTrigger();
		app.navigate("/create");
		app.controller.logout();
		old.resolve(module);
		await original;
		expect(app.firstTouch()).toBeNull();
		await app.controller.captureFirstTouch();
		expect(app.firstTouch()).toMatchObject({
			landingPath: "/create",
			source: "direct",
			referrerOrigin: null,
			utmSource: null,
		});
		expect(await app.controller.checkoutAttribution(async () => ({ id: "b" }))).toEqual({
			triggerPath: "/create",
		});
	});

	it("account switch while loading cannot donate an earlier owner's trigger", async () => {
		const old = deferred<typeof module>();
		const fresh = deferred<typeof module>();
		const app = harness(
			"true",
			vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise),
		);
		app.controller.syncIdentity({ id: "a" });
		app.controller.captureTrigger();
		app.navigate("/settings/billing");
		app.controller.syncIdentity({ id: "b" });
		old.resolve(module);
		await Promise.resolve();
		expect(app.firstTouch()).toBeNull();
		fresh.resolve(module);
		expect(await app.controller.checkoutAttribution(async () => ({ id: "b" }))).toEqual({
			triggerPath: "/settings/billing",
		});
		expect(app.firstTouch()).toBeNull();
	});

	it("closing a pending upgrade clears its queued click", async () => {
		const wait = deferred<typeof module>();
		const app = harness(
			"true",
			vi.fn(() => wait.promise),
		);
		app.controller.captureTrigger();
		app.controller.clearTrigger();
		app.navigate("/pricing");
		wait.resolve(module);
		expect(await app.controller.checkoutAttribution(async () => ({ id: "a" }))).toEqual({
			triggerPath: "/pricing",
		});
	});

	it("module failure remains optional for registration and checkout", async () => {
		const app = harness("true", vi.fn().mockRejectedValue(new Error("offline chunk")));
		await expect(app.controller.captureFirstTouch()).resolves.toBeUndefined();
		await expect(
			app.controller.checkoutAttribution(async () => ({ id: "a" })),
		).resolves.toBeUndefined();
		expect(app.firstTouch()).toMatchObject({ landingPath: "/blog/portrait" });
	});

	it("a new document restores consented first touch and the original hard-navigation click", async () => {
		const wait = deferred<typeof module>();
		const app = harness(
			"true",
			vi.fn(() => wait.promise),
		);
		const capture = app.controller.captureFirstTouch();
		app.controller.captureTrigger();
		app.navigate("/pricing?plan=ultimate");
		// A plain anchor replaces the entire facade, while browser cookies and
		// sessionStorage survive. The original import has not resolved.
		const nextDocument = createLazyPurchaseAttribution(app.runtime, async () => module);
		await nextDocument.captureFirstTouch();
		nextDocument.captureTrigger();
		expect(app.firstTouch()).toMatchObject({ landingPath: "/blog/portrait", utmSource: "google" });
		expect(await nextDocument.checkoutAttribution(async () => ({ id: "a" }))).toEqual({
			triggerPath: "/blog/portrait",
		});
		wait.resolve(module);
		await capture;
	});

	it("the first observed account change clears a pending click belonging to a stored owner", async () => {
		const app = harness();
		app.stored.set(IDENTITY_STORAGE_KEY, JSON.stringify({ ownerId: "a", blocked: true }));
		const wait = deferred<typeof module>();
		const controller = createLazyPurchaseAttribution(
			app.runtime,
			vi.fn().mockReturnValueOnce(wait.promise).mockResolvedValue(module),
		);
		controller.captureTrigger();
		app.navigate("/settings/billing");
		controller.syncIdentity({ id: "b" });
		wait.resolve(module);
		expect(await controller.checkoutAttribution(async () => ({ id: "b" }))).toEqual({
			triggerPath: "/settings/billing",
		});
		expect(app.firstTouch()).toBeNull();
	});

	it.each([{ id: "a" }, null])(
		"a stale auth refresh cannot overwrite a newer observed account (%j)",
		async (stale) => {
			const app = harness();
			await app.controller.captureFirstTouch();
			app.controller.captureTrigger();
			const user = deferred<{ id: string } | null>();
			const started = deferred<void>();
			const lookup = app.controller.checkoutAttribution(() => {
				started.resolve();
				return user.promise;
			});
			await started.promise;
			app.controller.syncIdentity({ id: "b" });
			user.resolve(stale);
			expect(await lookup).toBeUndefined();
			expect(JSON.parse(app.stored.get(IDENTITY_STORAGE_KEY)!)).toMatchObject({
				ownerId: "b",
				blocked: true,
			});
		},
	);

	it("a registered click during loading keeps its owner across document replacement", async () => {
		const old = deferred<typeof module>();
		const app = harness(
			"true",
			vi.fn(() => old.promise),
		);
		app.controller.syncIdentity({ id: "a" });
		app.controller.captureTrigger();
		app.navigate("/pricing");
		const next = deferred<typeof module>();
		const newDocument = createLazyPurchaseAttribution(
			app.runtime,
			vi.fn().mockReturnValueOnce(next.promise).mockResolvedValue(module),
		);
		newDocument.captureTrigger();
		expect(JSON.parse(app.stored.get(CHECKOUT_TRIGGER_STORAGE_KEY)!)).toMatchObject({
			ownerId: "a",
			path: "/blog/portrait",
		});
		newDocument.syncIdentity({ id: "b" });
		next.resolve(module);
		expect(await newDocument.checkoutAttribution(async () => ({ id: "b" }))).toEqual({
			triggerPath: "/pricing",
		});
		expect(app.firstTouch()).toBeNull();
		old.resolve(module);
	});

	it("a stalled optional chunk cannot keep registration or checkout pending", async () => {
		vi.useFakeTimers();
		try {
			const wait = deferred<typeof module>();
			const app = harness(
				"true",
				vi.fn(() => wait.promise),
			);
			const capture = app.controller.captureFirstTouch();
			const lookup = app.controller.checkoutAttribution(async () => ({ id: "a" }));
			await vi.advanceTimersByTimeAsync(1_500);
			await expect(capture).resolves.toBeUndefined();
			await expect(lookup).resolves.toBeUndefined();
			app.controller.registrationComplete();
			wait.resolve(module);
			await Promise.resolve();
			expect(app.firstTouch()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("withdrawal during an auth refresh prevents that checkout from reviving old data", async () => {
		const app = harness();
		await app.controller.captureFirstTouch();
		app.controller.syncIdentity({ id: "a" });
		app.controller.captureTrigger();
		const user = deferred<{ id: string }>();
		const started = deferred<void>();
		const lookup = app.controller.checkoutAttribution(() => {
			started.resolve();
			return user.promise;
		});
		await started.promise;
		app.controller.withdraw();
		app.navigate("/pricing");
		user.resolve({ id: "a" });
		expect(await lookup).toBeUndefined();
		expect(app.firstTouch()).toBeNull();
		expect(app.stored.has(CHECKOUT_TRIGGER_STORAGE_KEY)).toBe(false);
	});
});
