import { z } from "zod";

export const EZPIC_GROWTH_EVENT_NAMES = [
	"landing_viewed",
	"example_prompt_selected",
	"source_upload_started",
	"source_upload_completed",
	"marketing_draft_created",
	"auth_handoff_started",
	"draft_claimed",
	"editor_quote_created",
	"editor_generation_confirmed",
	"editor_generation_succeeded",
	"editor_generation_failed",
	"result_compared",
	"result_downloaded",
	"edit_again_started",
	"edit_session_opened",
	"upgrade_prompt_viewed",
	"checkout_started",
	"subscription_activated",
	"guest_generation_admitted",
	"guest_result_ready",
	"guest_result_viewed",
	"guest_watermarked_downloaded",
	"guest_sign_in_cta_started",
	"guest_registered_session_established",
	"guest_result_grant_completed",
] as const;

export const growthAnalyticsEventNameSchema = z.enum(EZPIC_GROWTH_EVENT_NAMES);

export const growthAnalyticsPropertiesSchema = z
	.object({
		plan: z.enum(["free", "creator", "studio"]).optional(),
		productKey: z.enum(["image-fast", "image-quality"]).optional(),
		status: z
			.enum([
				"viewed",
				"selected",
				"started",
				"completed",
				"created",
				"claimed",
				"confirmed",
				"succeeded",
				"failed",
				"compared",
				"downloaded",
				"opened",
				"activated",
				"unavailable",
				"admitted",
				"ready",
				"registered",
			])
			.optional(),
		creditsBucket: z
			.enum(["0", "1-9", "10-24", "25-99", "100-499", "500-999", "1000-4999", "5000-plus"])
			.optional(),
		latencyBucket: z.enum(["under-1s", "1-4s", "5-14s", "15-59s", "60s-plus"]).optional(),
		anonymousSessionHash: z
			.string()
			.regex(/^sha256:[a-f0-9]{64}$/)
			.optional(),
	})
	.strict();

export const growthAnalyticsEventSchema = z
	.object({
		name: growthAnalyticsEventNameSchema,
		properties: growthAnalyticsPropertiesSchema.optional().default({}),
	})
	.strict();

export type GrowthAnalyticsEventName = z.infer<typeof growthAnalyticsEventNameSchema>;
export type GrowthAnalyticsProperties = z.infer<typeof growthAnalyticsPropertiesSchema>;
export type GrowthAnalyticsEvent = z.infer<typeof growthAnalyticsEventSchema>;
export type GrowthAnalyticsTrackResult = "blocked" | "duplicate" | "failed" | "rejected" | "sent";

export const EZPIC_GROWTH_EVENT_FIXTURE = "ezpic:growth-event";
export const EZPIC_ANALYTICS_SESSION_COOKIE = "ezpic_analytics_session";

const sensitiveKeyPatterns = [
	/^prompt$/,
	/^file(name|path)?$/,
	/^asset(?:id|url|key|path)?$/,
	/^signed(?:url)?$/,
	/^(?:source|output|providerstatus|providerresult)?url$/,
	/^(?:raw)?jobid$/,
	/^email$/,
	/^cookie$/,
	/(?:access|refresh|auth|session)?token$/,
	/^provider$/,
	/^provider(?:model|task)id$/,
	/^modelid$/,
	/^(?:provider)?cost(?:micros)?$/,
	/^(?:provider)?rawresponse$/,
	/^(?:provider)?response(?:body|snapshot)?$/,
	/^request(?:body|snapshot)?$/,
] as const;

const urlPattern = /https?:\/\//i;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const bearerPattern = /\bbearer\s+[A-Za-z0-9._~+/=-]+/i;
const signedQueryPattern = /(?:x-amz-(?:signature|credential)|signature|signedurl|access_token)=/i;

function normalizedKey(value: string): string {
	return value.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizedKey(key);
	return sensitiveKeyPatterns.some((pattern) => pattern.test(normalized));
}

function isSensitiveString(value: string): boolean {
	return (
		urlPattern.test(value) ||
		emailPattern.test(value) ||
		bearerPattern.test(value) ||
		signedQueryPattern.test(value)
	);
}

export function containsSensitiveAnalyticsData(value: unknown): boolean {
	if (typeof value === "string") return isSensitiveString(value);
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(containsSensitiveAnalyticsData);

	return Object.entries(value).some(
		([key, child]) => isSensitiveKey(key) || containsSensitiveAnalyticsData(child),
	);
}

export function createGrowthAnalyticsDispatcher(options: {
	hasConsent: () => boolean;
	send: (event: GrowthAnalyticsEvent) => Promise<void> | void;
}) {
	const deliveredDedupeKeys = new Set<string>();

	return {
		async track(
			input: unknown,
			trackOptions?: { dedupeKey?: string },
		): Promise<GrowthAnalyticsTrackResult> {
			if (containsSensitiveAnalyticsData(input)) return "rejected";
			const parsed = growthAnalyticsEventSchema.safeParse(input);
			if (!parsed.success) return "rejected";
			if (!options.hasConsent()) return "blocked";

			const dedupeKey = trackOptions?.dedupeKey;
			if (dedupeKey && deliveredDedupeKeys.has(dedupeKey)) return "duplicate";

			try {
				await options.send(parsed.data);
				if (dedupeKey) deliveredDedupeKeys.add(dedupeKey);
				return "sent";
			} catch {
				return "failed";
			}
		},
	};
}

export function hasGrowthAnalyticsConsent(cookie: string): boolean {
	return cookie.split(";").some((part) => part.trim() === "consent=true");
}

export function createBrowserGrowthAnalyticsDispatcher(runtime: {
	getCookie: () => string;
	dispatch: (eventName: string, detail: GrowthAnalyticsEvent) => void;
	resolveAnonymousSessionHash?: () => Promise<string | undefined>;
	sendExternal?: (event: GrowthAnalyticsEvent) => Promise<void>;
}) {
	return createGrowthAnalyticsDispatcher({
		hasConsent: () => hasGrowthAnalyticsConsent(runtime.getCookie()),
		send: async (event) => {
			const anonymousSessionHash = await runtime.resolveAnonymousSessionHash?.();
			const enriched = growthAnalyticsEventSchema.parse({
				...event,
				properties: {
					...event.properties,
					...(anonymousSessionHash ? { anonymousSessionHash } : {}),
				},
			});
			runtime.dispatch(EZPIC_GROWTH_EVENT_FIXTURE, enriched);
			await runtime.sendExternal?.(enriched);
		},
	});
}

let browserGrowthAnalyticsDispatcher:
	| ReturnType<typeof createBrowserGrowthAnalyticsDispatcher>
	| undefined;

export function trackBrowserGrowthEvent(
	event: unknown,
	options?: { dedupeKey?: string },
): Promise<GrowthAnalyticsTrackResult> {
	browserGrowthAnalyticsDispatcher ??= createBrowserGrowthAnalyticsDispatcher({
		getCookie: () => (typeof document === "undefined" ? "" : (document.cookie ?? "")),
		resolveAnonymousSessionHash: getOrCreateBrowserGrowthAnalyticsSessionHash,
		dispatch: (eventName, detail) => {
			if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
				throw new Error("BROWSER_GROWTH_ANALYTICS_UNAVAILABLE");
			}
			window.dispatchEvent(new CustomEvent(eventName, { detail }));
		},
		sendExternal: sendConfiguredPostHogGrowthEvent,
	});
	return browserGrowthAnalyticsDispatcher.track(event, options);
}

export function readGrowthAnalyticsSessionHash(cookie: string): string | undefined {
	for (const part of cookie.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name !== EZPIC_ANALYTICS_SESSION_COOKIE) continue;
		let value: string;
		try {
			value = decodeURIComponent(valueParts.join("="));
		} catch {
			return undefined;
		}
		if (/^sha256:[a-f0-9]{64}$/.test(value)) return value;
	}
	return undefined;
}

export function createPostHogGrowthSender(options: {
	key: string;
	host: string;
	fetch: typeof fetch;
}): (event: unknown) => Promise<void> {
	if (!/^phc_[A-Za-z0-9_-]{10,}$/.test(options.key)) {
		throw new Error("NEXT_PUBLIC_POSTHOG_KEY is invalid");
	}
	const host = productionAnalyticsHost(options.host);
	return async (input) => {
		if (containsSensitiveAnalyticsData(input)) throw new Error("ANALYTICS_EVENT_REJECTED");
		const event = growthAnalyticsEventSchema.parse(input);
		const distinctId = event.properties.anonymousSessionHash;
		if (!distinctId) throw new Error("ANALYTICS_SESSION_REQUIRED");
		const response = await options.fetch(new URL("/capture/", host).toString(), {
			method: "POST",
			credentials: "omit",
			keepalive: true,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				api_key: options.key,
				event: event.name,
				properties: { ...event.properties, distinct_id: distinctId, $lib: "ezpic-browser" },
			}),
		});
		if (!response.ok) throw new Error("POSTHOG_INGESTION_FAILED");
	};
}

async function getOrCreateBrowserGrowthAnalyticsSessionHash(): Promise<string | undefined> {
	if (typeof document === "undefined" || typeof crypto === "undefined") return undefined;
	const existing = readGrowthAnalyticsSessionHash(document.cookie);
	if (existing) return existing;
	if (!crypto.getRandomValues || !crypto.subtle) return undefined;
	const random = crypto.getRandomValues(new Uint8Array(32));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", random));
	const hash = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	const secure =
		typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `${EZPIC_ANALYTICS_SESSION_COOKIE}=${hash}; Path=/; Max-Age=2592000; SameSite=Lax${secure}`;
	return hash;
}

let configuredPostHogSender: ((event: unknown) => Promise<void>) | null | undefined;

async function sendConfiguredPostHogGrowthEvent(event: GrowthAnalyticsEvent): Promise<void> {
	if (configuredPostHogSender === undefined) {
		const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
		const host = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
		if (!key && !host) configuredPostHogSender = null;
		else if (!key || !host) throw new Error("POSTHOG_CONFIGURATION_INCOMPLETE");
		else configuredPostHogSender = createPostHogGrowthSender({ key, host, fetch });
	}
	await configuredPostHogSender?.(event);
}

function productionAnalyticsHost(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("NEXT_PUBLIC_POSTHOG_HOST is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hostname.endsWith(".invalid") ||
		["localhost", "127.0.0.1", "::1"].includes(url.hostname)
	) {
		throw new Error("NEXT_PUBLIC_POSTHOG_HOST must be a real HTTPS origin");
	}
	return new URL(url.origin);
}

type EzPicProductKey = "image-fast" | "image-quality";
type EzPicPaidPlan = "creator" | "studio";
type TrackGrowthEvent = (
	event: GrowthAnalyticsEvent,
	options?: { dedupeKey?: string },
) => Promise<GrowthAnalyticsTrackResult>;

export function createSaasGrowthFunnel(track: TrackGrowthEvent = trackBrowserGrowthEvent) {
	return {
		draftClaimed: (key: string, productKey: EzPicProductKey) =>
			track(
				{ name: "draft_claimed", properties: { productKey, status: "claimed" } },
				{ dedupeKey: `draft-claimed:${key}` },
			),
		quoteCreated: (key: string, productKey: EzPicProductKey, credits: number) =>
			track(
				{
					name: "editor_quote_created",
					properties: {
						creditsBucket: bucketGrowthCredits(credits),
						productKey,
						status: "created",
					},
				},
				{ dedupeKey: `editor-quote-created:${key}` },
			),
		generationConfirmed: (key: string, productKey: EzPicProductKey) =>
			track(
				{ name: "editor_generation_confirmed", properties: { productKey, status: "confirmed" } },
				{ dedupeKey: `editor-generation-confirmed:${key}` },
			),
		generationSucceeded: (key: string, productKey: EzPicProductKey, latencyMs: number) =>
			track(
				{
					name: "editor_generation_succeeded",
					properties: {
						latencyBucket: bucketGrowthLatency(latencyMs),
						productKey,
						status: "succeeded",
					},
				},
				{ dedupeKey: `editor-generation-succeeded:${key}` },
			),
		generationFailed: (key: string, productKey: EzPicProductKey, latencyMs: number) =>
			track(
				{
					name: "editor_generation_failed",
					properties: {
						latencyBucket: bucketGrowthLatency(latencyMs),
						productKey,
						status: "failed",
					},
				},
				{ dedupeKey: `editor-generation-failed:${key}` },
			),
		resultCompared: (key: string, productKey: EzPicProductKey) =>
			track(
				{ name: "result_compared", properties: { productKey, status: "compared" } },
				{ dedupeKey: `result-compared:${key}` },
			),
		resultDownloaded: (key: string, productKey: EzPicProductKey) =>
			track(
				{ name: "result_downloaded", properties: { productKey, status: "downloaded" } },
				{ dedupeKey: `result-downloaded:${key}` },
			),
		editAgainStarted: (key: string, productKey: EzPicProductKey) =>
			track(
				{ name: "edit_again_started", properties: { productKey, status: "started" } },
				{ dedupeKey: `edit-again-started:${key}` },
			),
		editSessionOpened: (key: string) =>
			track(
				{ name: "edit_session_opened", properties: { status: "opened" } },
				{ dedupeKey: `edit-session-opened:${key}` },
			),
		upgradePromptViewed: (productKey: EzPicProductKey) =>
			track(
				{ name: "upgrade_prompt_viewed", properties: { productKey, status: "viewed" } },
				{ dedupeKey: `upgrade-prompt-viewed:${productKey}` },
			),
		checkoutStarted: (key: string, plan: EzPicPaidPlan) =>
			track(
				{ name: "checkout_started", properties: { plan, status: "started" } },
				{ dedupeKey: `checkout-started:${key}` },
			),
		subscriptionActivated: (plan: EzPicPaidPlan) =>
			track(
				{ name: "subscription_activated", properties: { plan, status: "activated" } },
				{ dedupeKey: `subscription-activated:${plan}` },
			),
		guestGenerationAdmitted: (key: string) =>
			track(
				{ name: "guest_generation_admitted", properties: { status: "admitted" } },
				{ dedupeKey: `guest-generation-admitted:${key}` },
			),
		guestResultReady: (key: string) =>
			track(
				{ name: "guest_result_ready", properties: { status: "ready" } },
				{ dedupeKey: `guest-result-ready:${key}` },
			),
		guestResultViewed: (key: string) =>
			track(
				{ name: "guest_result_viewed", properties: { status: "viewed" } },
				{ dedupeKey: `guest-result-viewed:${key}` },
			),
		guestWatermarkedDownloaded: (key: string) =>
			track(
				{ name: "guest_watermarked_downloaded", properties: { status: "downloaded" } },
				{ dedupeKey: `guest-watermarked-downloaded:${key}` },
			),
		guestSignInCtaStarted: (key: string) =>
			track(
				{ name: "guest_sign_in_cta_started", properties: { status: "started" } },
				{ dedupeKey: `guest-sign-in-cta-started:${key}` },
			),
		guestRegisteredSessionEstablished: (key: string) =>
			track(
				{ name: "guest_registered_session_established", properties: { status: "registered" } },
				{ dedupeKey: `guest-registered-session-established:${key}` },
			),
		guestResultGrantCompleted: (key: string) =>
			track(
				{ name: "guest_result_grant_completed", properties: { status: "completed" } },
				{ dedupeKey: `guest-result-grant-completed:${key}` },
			),
	};
}

export function bucketGrowthCredits(credits: number): GrowthAnalyticsProperties["creditsBucket"] {
	if (!Number.isFinite(credits) || credits <= 0) return "0";
	if (credits < 10) return "1-9";
	if (credits < 25) return "10-24";
	if (credits < 100) return "25-99";
	if (credits < 500) return "100-499";
	if (credits < 1_000) return "500-999";
	if (credits < 5_000) return "1000-4999";
	return "5000-plus";
}

export function bucketGrowthLatency(
	milliseconds: number,
): GrowthAnalyticsProperties["latencyBucket"] {
	if (!Number.isFinite(milliseconds) || milliseconds < 1_000) return "under-1s";
	if (milliseconds < 5_000) return "1-4s";
	if (milliseconds < 15_000) return "5-14s";
	if (milliseconds < 60_000) return "15-59s";
	return "60s-plus";
}
