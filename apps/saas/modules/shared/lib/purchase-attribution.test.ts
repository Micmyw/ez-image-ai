import { ATTRIBUTION_COOKIE_NAME } from "@repo/utils/lib/acquisition-attribution";
import { describe, expect, it } from "vitest";

import {
	createPurchaseAttribution,
	resolveCurrentCheckoutAttribution,
} from "./purchase-attribution-controller";
import { CHECKOUT_TRIGGER_STORAGE_KEY } from "./purchase-attribution-storage";

function harness(
	consent = "true",
	initialUrl = "https://ezimageai.com/blog/portrait?utm_source=google&utm_medium=cpc&utm_campaign=fall&token=secret-token&email=private%40example.com#private",
) {
	let url = new URL(initialUrl);
	let time = new Date("2026-10-08T10:00:00.000Z");
	const cookies = new Map<string, string>([["consent", consent]]);
	const stored = new Map<string, string>();
	const writes: string[] = [];
	const runtime = {
		location: () => url,
		referrer: () => "https://www.google.com/search?token=referrer-secret#private",
		cookie: () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
		writeCookie: (value: string) => {
			writes.push(value);
			const pair = value.split(";")[0]!;
			const separator = pair.indexOf("=");
			if (value.includes("Max-Age=0")) cookies.delete(pair.slice(0, separator));
			else cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
		},
		storage: {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => stored.set(key, value),
			removeItem: (key: string) => stored.delete(key),
		},
		now: () => time,
	};
	const controller = createPurchaseAttribution(runtime);
	return {
		controller,
		runtime,
		cookies,
		stored,
		writes,
		navigate: (path: string) => {
			url = new URL(path, url);
		},
		advance: (ms: number) => {
			time = new Date(time.getTime() + ms);
		},
		firstTouch: () =>
			JSON.parse(decodeURIComponent(cookies.get(ATTRIBUTION_COOKIE_NAME) ?? "null")),
	};
}

describe("consented registration first touch", () => {
	it.each(["", "false"])("never writes optional attribution when consent=%s", (consent) => {
		const app = harness(consent);
		app.cookies.set(ATTRIBUTION_COOKIE_NAME, "stale");
		app.stored.set(CHECKOUT_TRIGGER_STORAGE_KEY, "stale");
		app.controller.captureFirstTouch();
		app.controller.captureTrigger();
		expect(app.controller.checkoutAttribution()).toBeUndefined();
		expect(app.cookies.has(ATTRIBUTION_COOKIE_NAME)).toBe(false);
		expect(app.stored.size).toBe(0);
		expect(app.writes.every((write) => write.includes("Max-Age=0"))).toBe(true);
	});
	it("retains the initial landing in memory until acceptance and saves only controlled data", () => {
		const app = harness("");
		app.controller.captureFirstTouch();
		app.navigate("/pricing?plan=ultimate");
		app.cookies.set("consent", "true");
		app.controller.captureFirstTouch();
		expect(app.firstTouch()).toEqual({
			version: 1,
			landingPath: "/blog/portrait",
			referrerOrigin: "https://www.google.com",
			source: "campaign",
			utmSource: "google",
			utmMedium: "cpc",
			utmCampaign: "fall",
			capturedAt: "2026-10-08T10:00:00.000Z",
		});
		const value = JSON.stringify(app.firstTouch());
		expect(value).not.toMatch(/secret|private|example\.com|#|\?/);
		expect(app.writes.at(-1)).toContain("Max-Age=2592000; SameSite=Lax; Secure");
	});
	it("preserves first touch on later pages and a later browser visit without extending it", () => {
		const app = harness();
		app.controller.captureFirstTouch();
		const first = app.firstTouch();
		app.navigate("/create");
		app.advance(24 * 60 * 60_000);
		app.controller.captureFirstTouch();
		createPurchaseAttribution(app.runtime).captureFirstTouch();
		expect(app.firstTouch()).toEqual(first);
		expect(app.writes).toHaveLength(1);
	});
	it("does not resurrect consumed signup attribution or assign it to another account", () => {
		const app = harness();
		app.controller.captureFirstTouch();
		app.controller.registrationComplete();
		app.navigate("/signup");
		app.controller.captureFirstTouch();
		createPurchaseAttribution(app.runtime).captureFirstTouch();
		expect(app.firstTouch()).toBeNull();
		app.controller.syncIdentity({ id: "account-a" });
		app.controller.syncIdentity({ id: "account-b" });
		app.controller.captureFirstTouch();
		expect(app.firstTouch()).toBeNull();
	});
	it("keeps guest acquisition until registration and clears it when a registered account appears", () => {
		const app = harness();
		app.controller.syncIdentity({ id: "guest", isAnonymous: true });
		app.controller.captureFirstTouch();
		expect(app.firstTouch().landingPath).toBe("/blog/portrait");
		app.controller.syncIdentity({ id: "account-a", isAnonymous: false });
		app.controller.captureFirstTouch();
		expect(app.firstTouch()).toBeNull();
	});
	it("does not turn consent reacceptance by a signed-in account into a new acquisition", () => {
		const app = harness();
		app.controller.syncIdentity({ id: "account-a" });
		app.cookies.set("consent", "false");
		app.controller.withdraw();
		app.cookies.set("consent", "true");
		app.controller.captureFirstTouch();
		expect(app.firstTouch()).toBeNull();
		expect(app.stored.size).toBe(0);
	});
	it("starts a fresh direct acquisition after logout without the old external campaign", () => {
		const app = harness();
		app.controller.captureFirstTouch();
		app.controller.syncIdentity({ id: "account-a" });
		app.navigate("/create");
		app.controller.logout();
		app.controller.captureFirstTouch();
		expect(app.firstTouch()).toMatchObject({
			landingPath: "/create",
			referrerOrigin: null,
			source: "direct",
			utmSource: null,
		});
	});
});

describe("checkout trigger handoff", () => {
	it("preserves the product trigger when navigation opens the homepage pricing section", () => {
		const app = harness("true", "https://ezimageai.com/create?job=private-job");
		app.controller.captureTrigger();
		app.navigate("/#pricing");
		app.controller.captureTrigger();
		expect(app.controller.checkoutAttribution()).toEqual({ triggerPath: "/create" });
	});
	it("refreshes the shared cookie identity before checkout after another tab changes accounts", async () => {
		const app = harness();
		app.controller.syncIdentity({ id: "account-a" });
		app.controller.captureTrigger();
		app.navigate("/pricing");
		expect(
			await resolveCurrentCheckoutAttribution(app.controller, async () => ({ id: "account-b" })),
		).toEqual({ triggerPath: "/pricing" });
		expect(app.stored.has(CHECKOUT_TRIGGER_STORAGE_KEY)).toBe(false);
	});
	it("drops optional attribution when the fresh session is signed out, anonymous, or unavailable", async () => {
		const app = harness();
		app.controller.syncIdentity({ id: "account-a" });
		app.controller.captureTrigger();
		expect(
			await resolveCurrentCheckoutAttribution(app.controller, async () => null),
		).toBeUndefined();
		expect(
			await resolveCurrentCheckoutAttribution(app.controller, async () => ({
				id: "guest",
				isAnonymous: true,
			})),
		).toBeUndefined();
		expect(
			await resolveCurrentCheckoutAttribution(app.controller, async () => {
				throw new Error("Offline");
			}),
		).toBeUndefined();
	});
	it("preserves the actual content click through login, registration and the pricing dialog", () => {
		const app = harness();
		app.controller.captureTrigger();
		app.navigate("/login?redirectTo=%2Fpricing");
		app.controller.syncIdentity({ id: "account-a" });
		app.navigate("/pricing?plan=ultimate&interval=year");
		app.controller.captureTrigger();
		expect(app.controller.checkoutAttribution("account-a")).toEqual({
			triggerPath: "/blog/portrait",
		});
		expect(createPurchaseAttribution(app.runtime).checkoutAttribution("account-a")).toEqual({
			triggerPath: "/blog/portrait",
		});
	});
	it("binds image and credit-pack purchase triggers to the authenticated account", () => {
		const app = harness("true", "https://ezimageai.com/create?job=private-job#private");
		app.controller.syncIdentity({ id: "account-a" });
		app.controller.captureTrigger();
		app.navigate("/pricing");
		expect(app.controller.checkoutAttribution("account-a")).toEqual({ triggerPath: "/create" });
		expect(app.controller.checkoutAttribution("account-b")).toEqual({ triggerPath: "/pricing" });
		app.controller.syncIdentity({ id: "account-b" });
		expect(app.stored.has(CHECKOUT_TRIGGER_STORAGE_KEY)).toBe(false);
	});
	it("does not reuse a completed or closed purchase trigger", () => {
		const app = harness();
		app.controller.captureTrigger();
		app.navigate("/pricing");
		app.controller.clearTrigger();
		expect(app.controller.checkoutAttribution()).toEqual({ triggerPath: "/pricing" });
	});
	it("expires old handoffs and rejects malformed or future storage", () => {
		const app = harness();
		app.controller.captureTrigger();
		app.navigate("/pricing");
		app.advance(60 * 60_000 + 1);
		expect(app.controller.checkoutAttribution()).toEqual({ triggerPath: "/pricing" });
		app.stored.set(
			CHECKOUT_TRIGGER_STORAGE_KEY,
			JSON.stringify({
				path: "https://attacker.com/?email=private",
				capturedAt: Date.now(),
				ownerId: null,
			}),
		);
		expect(createPurchaseAttribution(app.runtime).checkoutAttribution()).toEqual({
			triggerPath: "/pricing",
		});
		app.stored.set(
			CHECKOUT_TRIGGER_STORAGE_KEY,
			JSON.stringify({ path: "/blog/portrait", capturedAt: Date.now() + 9_999_999, ownerId: null }),
		);
		expect(createPurchaseAttribution(app.runtime).checkoutAttribution()).toEqual({
			triggerPath: "/pricing",
		});
	});
	it("redacts private resource identities and uses unknown for sensitive auth paths", () => {
		const app = harness("true", "https://ezimageai.com/history/private-job?token=secret");
		app.controller.captureTrigger();
		expect(app.controller.checkoutAttribution()).toEqual({ triggerPath: "/history" });
		app.navigate("/api/auth/callback/google?code=secret");
		app.controller.captureTrigger();
		expect(app.controller.checkoutAttribution()).toEqual({ triggerPath: null });
	});
	it("allows immediate checkout when optional storage and cookies are disabled", () => {
		const app = harness("true", "https://ezimageai.com/create?token=secret");
		const blocked = () => {
			throw new Error("Storage disabled");
		};
		const controller = createPurchaseAttribution({
			...app.runtime,
			storage: { getItem: blocked, setItem: blocked, removeItem: blocked },
			writeCookie: blocked,
		});
		expect(() => controller.captureFirstTouch()).not.toThrow();
		controller.captureTrigger();
		app.navigate("/pricing");
		expect(controller.checkoutAttribution()).toEqual({ triggerPath: "/create" });
		expect(() => controller.logout()).not.toThrow();
	});
});
