import * as utils from "@repo/utils";
import { describe, expect, it, vi } from "vitest";

type BrowserGrowthAnalyticsModule = {
	EZPIC_GROWTH_EVENT_FIXTURE: string;
	createBrowserGrowthAnalyticsDispatcher: (runtime: {
		getCookie: () => string;
		dispatch: (eventName: string, detail: unknown) => void;
		resolveAnonymousSessionHash?: () => Promise<string | undefined>;
		sendExternal?: (event: unknown) => Promise<void>;
	}) => {
		track: (
			event: unknown,
			options?: { dedupeKey?: string },
		) => Promise<"blocked" | "duplicate" | "failed" | "rejected" | "sent">;
	};
	createPostHogGrowthSender: (options: {
		key: string;
		host: string;
		fetch: typeof fetch;
	}) => (event: unknown) => Promise<void>;
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

	it("enriches both app transports with one anonymous hash after consent", async () => {
		const createDispatcher = browserGrowthAnalytics.createBrowserGrowthAnalyticsDispatcher;
		expect(createDispatcher).toBeTypeOf("function");
		if (!createDispatcher) return;
		const anonymousSessionHash =
			"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		const dispatch = vi.fn();
		const sendExternal = vi.fn(async () => undefined);
		const dispatcher = createDispatcher({
			getCookie: () => "consent=true",
			dispatch,
			resolveAnonymousSessionHash: async () => anonymousSessionHash,
			sendExternal,
		});

		expect(
			await dispatcher.track({ name: "landing_viewed", properties: { status: "viewed" } }),
		).toBe("sent");
		const enriched = {
			name: "landing_viewed",
			properties: { status: "viewed", anonymousSessionHash },
		};
		expect(dispatch).toHaveBeenCalledWith("ezpic:growth-event", enriched);
		expect(sendExternal).toHaveBeenCalledWith(enriched);
	});

	it("sends the strict event to PostHog without prompts, URLs, or raw identifiers", async () => {
		const createSender = browserGrowthAnalytics.createPostHogGrowthSender;
		expect(createSender).toBeTypeOf("function");
		if (!createSender) return;
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
		const sender = createSender({
			key: "phc_public_project_key_123456",
			host: "https://us.i.posthog.com",
			fetch: fetchMock,
		});
		const anonymousSessionHash =
			"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		await sender({
			name: "editor_generation_succeeded",
			properties: { productKey: "image-fast", status: "succeeded", anonymousSessionHash },
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://us.i.posthog.com/capture/");
		expect(init).toMatchObject({ method: "POST", credentials: "omit", keepalive: true });
		expect(init?.body).toBeTypeOf("string");
		if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
		const body = JSON.parse(init.body) as Record<string, unknown>;
		expect(body).toMatchObject({
			api_key: "phc_public_project_key_123456",
			event: "editor_generation_succeeded",
			properties: expect.objectContaining({ distinct_id: anonymousSessionHash }),
		});
		expect(JSON.stringify(body)).not.toMatch(
			/prompt|asset|signed|provider|model|cost|email|token/i,
		);
	});
});
