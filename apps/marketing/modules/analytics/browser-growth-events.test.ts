import * as utils from "@repo/utils";
import { describe, expect, it, vi } from "vitest";

type BrowserGrowthAnalyticsModule = {
	EZPIC_GROWTH_EVENT_FIXTURE: string;
	createBrowserGrowthAnalyticsDispatcher: (runtime: {
		getCookie: () => string;
		dispatch: (eventName: string, detail: unknown) => void;
	}) => {
		track: (
			event: unknown,
			options?: { dedupeKey?: string },
		) => Promise<"blocked" | "duplicate" | "failed" | "rejected" | "sent">;
	};
	hasGrowthAnalyticsConsent: (cookie: string) => boolean;
};

const browserGrowthAnalytics = utils as typeof utils & Partial<BrowserGrowthAnalyticsModule>;

describe("browser growth analytics fixture transport", () => {
	it("recognizes only the explicit consent=true cookie", () => {
		const hasConsent = browserGrowthAnalytics.hasGrowthAnalyticsConsent;
		expect(hasConsent).toBeTypeOf("function");
		if (!hasConsent) return;

		expect(hasConsent("consent=true")).toBe(true);
		expect(hasConsent("theme=dark; consent=true; locale=en")).toBe(true);
		for (const cookie of ["", "consent=false", "analytics=true", "notconsent=true"]) {
			expect(hasConsent(cookie), cookie).toBe(false);
		}
	});

	it("dispatches only a consented, schema-safe local CustomEvent fixture", async () => {
		const createDispatcher = browserGrowthAnalytics.createBrowserGrowthAnalyticsDispatcher;
		const eventName = browserGrowthAnalytics.EZPIC_GROWTH_EVENT_FIXTURE;
		expect(createDispatcher).toBeTypeOf("function");
		expect(eventName).toBe("ezpic:growth-event");
		if (!createDispatcher || !eventName) return;

		let cookie = "consent=false";
		const dispatch = vi.fn();
		const dispatcher = createDispatcher({ getCookie: () => cookie, dispatch });
		const event = {
			name: "source_upload_completed",
			properties: { productKey: "image-fast", status: "completed" },
		};

		expect(await dispatcher.track(event, { dedupeKey: "upload:fixture-1" })).toBe("blocked");
		expect(dispatch).not.toHaveBeenCalled();

		cookie = "consent=true";
		expect(await dispatcher.track(event, { dedupeKey: "upload:fixture-1" })).toBe("sent");
		expect(dispatch).toHaveBeenCalledWith("ezpic:growth-event", event);
		expect(await dispatcher.track(event, { dedupeKey: "upload:fixture-1" })).toBe("duplicate");
		expect(dispatch).toHaveBeenCalledTimes(1);

		expect(
			await dispatcher.track({
				name: "source_upload_completed",
				properties: { fileName: "private-family-photo.png" },
			}),
		).toBe("rejected");
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("keeps a failed local dispatch retryable", async () => {
		const createDispatcher = browserGrowthAnalytics.createBrowserGrowthAnalyticsDispatcher;
		expect(createDispatcher).toBeTypeOf("function");
		if (!createDispatcher) return;

		const dispatch = vi
			.fn<(eventName: string, detail: unknown) => void>()
			.mockImplementationOnce(() => {
				throw new Error("fixture listener unavailable");
			});
		const dispatcher = createDispatcher({ getCookie: () => "consent=true", dispatch });
		const event = { name: "landing_viewed", properties: { status: "viewed" } };

		expect(await dispatcher.track(event, { dedupeKey: "landing" })).toBe("failed");
		expect(await dispatcher.track(event, { dedupeKey: "landing" })).toBe("sent");
		expect(await dispatcher.track(event, { dedupeKey: "landing" })).toBe("duplicate");
		expect(dispatch).toHaveBeenCalledTimes(2);
	});
});
