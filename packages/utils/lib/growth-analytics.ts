import { EZPIC_PRODUCT_KEYS } from "@repo/config/client";
import { z } from "zod";

export const EZPIC_GROWTH_EVENT_NAMES = [
	"video_effect_view",
	"video_effect_sample_play",
	"video_effect_inputs_ready",
	"video_effect_quote_view",
	"video_effect_submit",
	"video_effect_accepted_observed",
	"video_effect_ready_observed",
	"video_effect_failed_observed",
	"video_effect_held_observed",
	"video_effect_download",
	"landing_viewed",
	"effect_viewed",
	"blog_viewed",
	"prompt_copied",
	"preset_selected",
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

export const EZPIC_ANALYTICS_PRODUCT_KEYS = EZPIC_PRODUCT_KEYS;

const contentIdSchema = z
	.string()
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
	.max(96);
const analyticsHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const contentAttributionShape = {
	effect_id: contentIdSchema.optional(),
	preset_id: contentIdSchema.optional(),
	preset_version: z.number().int().positive().max(1_000_000).optional(),
	source_blog_id: contentIdSchema.optional(),
	internal_source: z
		.enum(["effects-directory", "blog", "home", "image-to-image", "model", "effect"])
		.optional(),
	entry_path: z
		.string()
		.max(256)
		.regex(
			/^\/(?:video-effects\/hotel-lobby-ai|effects\/[a-z0-9]+(?:-[a-z0-9]+)*|blog\/[a-z0-9]+(?:[-/][a-z0-9]+)*)$/,
		)
		.optional(),
};

function validContentAttribution(value: z.infer<typeof contentAttributionBaseSchema>): boolean {
	const hasEffect = value.effect_id !== undefined;
	if (hasEffect !== (value.preset_id !== undefined && value.preset_version !== undefined)) {
		return false;
	}
	if (!hasEffect && (value.preset_id !== undefined || value.preset_version !== undefined)) {
		return false;
	}
	const hasContent = hasEffect || value.source_blog_id !== undefined;
	return (
		hasContent &&
		value.entry_path !== undefined &&
		value.internal_source !== undefined &&
		(hasEffect || (value.internal_source === "blog" && value.entry_path.startsWith("/blog/")))
	);
}

const contentAttributionBaseSchema = z.object(contentAttributionShape).strict();
export const growthContentAttributionSchema = contentAttributionBaseSchema.refine(
	validContentAttribution,
	"Content attribution needs a complete registered effect/preset or a blog reference.",
);
export type GrowthContentAttribution = z.infer<typeof growthContentAttributionSchema>;

export const growthAnalyticsPropertiesSchema = z
	.object({
		...contentAttributionShape,
		task_hash: analyticsHashSchema.optional(),
		plan: z.enum(["free", "creator", "ultimate", "studio"]).optional(),
		productKey: z.enum(EZPIC_ANALYTICS_PRODUCT_KEYS).optional(),
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
				"copied",
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
	.strict()
	.refine((value) => {
		const attribution = Object.fromEntries(
			Object.keys(contentAttributionShape)
				.filter((key) => value[key as keyof typeof value] !== undefined)
				.map((key) => [key, value[key as keyof typeof value]]),
		);
		return (
			Object.keys(attribution).length === 0 ||
			growthContentAttributionSchema.safeParse(attribution).success
		);
	});

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
export const EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY = "ezpic:content-attribution:v1";
export const EZPIC_CONTENT_ATTRIBUTION_MAX_AGE_MS = 30 * 60_000;

const storedAttributionSchema = z
	.object({
		context: growthContentAttributionSchema.optional(),
		expiresAt: z.number().finite(),
		tasks: z
			.array(
				z
					.object({
						hash: analyticsHashSchema,
						context: growthContentAttributionSchema,
						expiresAt: z.number().finite(),
						delivered: z.array(growthAnalyticsEventNameSchema).max(EZPIC_GROWTH_EVENT_NAMES.length),
					})
					.strict(),
			)
			.max(20),
	})
	.strict();

/** Only bounded public references and one-way task hashes are retained in this tab. */
export function createGrowthContentAttributionStore(runtime: {
	hasConsent: () => boolean;
	storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
	now?: () => number;
}) {
	type State = z.infer<typeof storedAttributionSchema>;
	let state: State | undefined;
	const now = runtime.now ?? Date.now;
	function clear() {
		state = undefined;
		try {
			runtime.storage?.removeItem(EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY);
		} catch {
			/* Storage can be unavailable. */
		}
	}
	function save(value: State) {
		state = value;
		try {
			runtime.storage?.setItem(EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY, JSON.stringify(value));
		} catch {
			/* Memory-only attribution still works. */
		}
	}
	function readState(): State | undefined {
		if (!runtime.hasConsent()) {
			clear();
			return undefined;
		}
		if (!state) {
			try {
				const parsed = storedAttributionSchema.safeParse(
					JSON.parse(runtime.storage?.getItem(EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY) ?? "null"),
				);
				if (parsed.success) state = parsed.data;
				else clear();
			} catch {
				clear();
			}
		}
		if (!state) return undefined;
		const time = now();
		const tasks = state.tasks.filter(
			(task) =>
				task.expiresAt > time && task.expiresAt <= time + EZPIC_CONTENT_ATTRIBUTION_MAX_AGE_MS,
		);
		const context =
			state.expiresAt > time && state.expiresAt <= time + EZPIC_CONTENT_ATTRIBUTION_MAX_AGE_MS
				? state.context
				: undefined;
		if (!context && tasks.length === 0) {
			clear();
			return undefined;
		}
		state = { ...state, context, tasks };
		return state;
	}
	return {
		clear,
		clearContext() {
			const value = readState();
			if (!value) return;
			if (value.tasks.length === 0) clear();
			else save({ ...value, context: undefined, expiresAt: now() });
		},
		read: () => readState()?.context,
		set(input: unknown): boolean {
			if (!runtime.hasConsent()) {
				clear();
				return false;
			}
			const parsed = growthContentAttributionSchema.safeParse(input);
			if (!parsed.success || containsSensitiveAnalyticsData(input)) {
				clear();
				return false;
			}
			save({
				context: parsed.data,
				expiresAt: now() + EZPIC_CONTENT_ATTRIBUTION_MAX_AGE_MS,
				tasks: readState()?.tasks ?? [],
			});
			return true;
		},
		bindTask(hash: string, context: GrowthContentAttribution) {
			if (
				!runtime.hasConsent() ||
				!analyticsHashSchema.safeParse(hash).success ||
				!growthContentAttributionSchema.safeParse(context).success
			)
				return;
			const value = readState() ?? { expiresAt: now(), tasks: [] };
			if (value.tasks.some((task) => task.hash === hash)) return;
			save({
				...value,
				tasks: [
					...value.tasks,
					{ hash, context, expiresAt: now() + EZPIC_CONTENT_ATTRIBUTION_MAX_AGE_MS, delivered: [] },
				].slice(-20),
			});
		},
		readTask(hash: string) {
			return readState()?.tasks.find((task) => task.hash === hash);
		},
		markDelivered(hash: string, name: GrowthAnalyticsEventName) {
			const value = readState();
			if (!value) return;
			save({
				...value,
				tasks: value.tasks.map((task) =>
					task.hash === hash
						? { ...task, delivered: [...new Set([...task.delivered, name])] }
						: task,
				),
			});
		},
	};
}

export type GrowthAnalyticsAttributionSnapshot = Readonly<{
	enabled: boolean;
	context: GrowthContentAttribution | null;
	capturedAt: number;
}>;

/** Captures absence too: a request begun without content must never inherit a later page. */
export function snapshotGrowthContentAttribution(
	context: GrowthContentAttribution | undefined,
	enabled: boolean,
	now = Date.now(),
): GrowthAnalyticsAttributionSnapshot {
	const parsed = enabled && context ? growthContentAttributionSchema.safeParse(context) : undefined;
	return Object.freeze({
		enabled,
		context: parsed?.success ? Object.freeze(parsed.data) : null,
		capturedAt: now,
	});
}

type GrowthTrackOptions = {
	dedupeKey?: string;
	taskKey?: string;
	attribution?: GrowthAnalyticsAttributionSnapshot;
};
class GrowthDispatchSkipped extends Error {
	constructor(readonly result: "blocked" | "duplicate") {
		super(result);
	}
}

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
	send: (event: GrowthAnalyticsEvent, options?: GrowthTrackOptions) => Promise<void> | void;
}) {
	const deliveredDedupeKeys = new Set<string>();
	const pendingDedupeKeys = new Set<string>();

	return {
		async track(
			input: unknown,
			trackOptions?: GrowthTrackOptions,
		): Promise<GrowthAnalyticsTrackResult> {
			if (containsSensitiveAnalyticsData(input)) return "rejected";
			const parsed = growthAnalyticsEventSchema.safeParse(input);
			if (!parsed.success) return "rejected";
			if (!options.hasConsent()) return "blocked";

			const dedupeKey = trackOptions?.dedupeKey;
			if (dedupeKey && (deliveredDedupeKeys.has(dedupeKey) || pendingDedupeKeys.has(dedupeKey)))
				return "duplicate";

			try {
				if (dedupeKey) pendingDedupeKeys.add(dedupeKey);
				await options.send(parsed.data, trackOptions);
				if (dedupeKey) deliveredDedupeKeys.add(dedupeKey);
				return "sent";
			} catch (error) {
				if (error instanceof GrowthDispatchSkipped) return error.result;
				return "failed";
			} finally {
				if (dedupeKey) pendingDedupeKeys.delete(dedupeKey);
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
	attribution?: ReturnType<typeof createGrowthContentAttributionStore>;
	isSuppressed?: () => boolean;
	hashTask?: (sessionHash: string, key: string) => Promise<string | undefined>;
}) {
	return createGrowthAnalyticsDispatcher({
		hasConsent: () => {
			const consent = hasGrowthAnalyticsConsent(runtime.getCookie());
			if (!consent) runtime.attribution?.clear();
			return consent && !runtime.isSuppressed?.();
		},
		send: async (event, options) => {
			const snapshot = options?.attribution;
			if (
				snapshot &&
				(!snapshot.enabled ||
					!Number.isFinite(snapshot.capturedAt) ||
					snapshot.capturedAt > Date.now() ||
					Date.now() - snapshot.capturedAt >= EZPIC_CONTENT_ATTRIBUTION_MAX_AGE_MS)
			) {
				throw new GrowthDispatchSkipped("blocked");
			}
			const currentContext = snapshot
				? snapshot.context
					? growthContentAttributionSchema.parse(snapshot.context)
					: undefined
				: runtime.attribution?.read();
			const anonymousSessionHash = await runtime.resolveAnonymousSessionHash?.();
			const taskKey = taskKeyForGrowthEvent(event.name, options);
			const taskHash =
				anonymousSessionHash && taskKey
					? await (runtime.hashTask ?? hashGrowthTaskIdentity)(anonymousSessionHash, taskKey)
					: undefined;
			if (!hasGrowthAnalyticsConsent(runtime.getCookie()) || runtime.isSuppressed?.()) {
				runtime.attribution?.clear();
				throw new GrowthDispatchSkipped("blocked");
			}
			if (
				taskHash &&
				currentContext &&
				(event.name === "editor_generation_confirmed" || event.name === "guest_generation_admitted")
			) {
				runtime.attribution?.bindTask(taskHash, currentContext);
			}
			const task = taskHash ? runtime.attribution?.readTask(taskHash) : undefined;
			if (task?.delivered.includes(event.name)) throw new GrowthDispatchSkipped("duplicate");
			// A terminal event for an older job must not inherit the currently selected effect.
			const context = taskKey ? task?.context : currentContext;
			const enriched = growthAnalyticsEventSchema.parse({
				...event,
				properties: {
					...context,
					...event.properties,
					...(taskHash ? { task_hash: taskHash } : {}),
					...(anonymousSessionHash ? { anonymousSessionHash } : {}),
				},
			});
			runtime.dispatch(EZPIC_GROWTH_EVENT_FIXTURE, enriched);
			await runtime.sendExternal?.(enriched);
			if (taskHash) runtime.attribution?.markDelivered(taskHash, event.name);
		},
	});
}

let browserGrowthAnalyticsDispatcher:
	| ReturnType<typeof createBrowserGrowthAnalyticsDispatcher>
	| undefined;
let browserContentAttribution: ReturnType<typeof createGrowthContentAttributionStore> | undefined;
let browserGrowthAnalyticsSuppressed = false;

function browserAttributionStore() {
	if (!browserContentAttribution) {
		let storage: Storage | undefined;
		try {
			storage = typeof window === "undefined" ? undefined : window.sessionStorage;
		} catch {
			/* Privacy settings may disable storage. */
		}
		browserContentAttribution = createGrowthContentAttributionStore({
			hasConsent: () =>
				typeof document !== "undefined" && hasGrowthAnalyticsConsent(document.cookie ?? ""),
			storage,
		});
	}
	return browserContentAttribution;
}

export function setBrowserGrowthContentAttribution(context: unknown): boolean {
	return browserAttributionStore().set(context);
}

export function readBrowserGrowthContentAttribution(): GrowthContentAttribution | undefined {
	return browserAttributionStore().read();
}

export function clearBrowserGrowthContentAttribution() {
	browserAttributionStore().clear();
}

/** Clears the active page only. Previously admitted tasks keep their original context. */
export function clearBrowserGrowthActiveContentAttribution() {
	browserAttributionStore().clearContext();
}

export function captureBrowserGrowthAnalyticsAttribution(): GrowthAnalyticsAttributionSnapshot {
	const enabled =
		typeof document !== "undefined" &&
		hasGrowthAnalyticsConsent(document.cookie ?? "") &&
		!browserGrowthAnalyticsSuppressed;
	return snapshotGrowthContentAttribution(
		enabled ? browserAttributionStore().read() : undefined,
		enabled,
	);
}

/** Protected preview pages must suppress reused editor events too. */
export function setBrowserGrowthAnalyticsSuppressed(suppressed: boolean) {
	browserGrowthAnalyticsSuppressed = suppressed;
	if (suppressed) clearBrowserGrowthContentAttribution();
}

export function trackBrowserGrowthEvent(
	event: unknown,
	options?: GrowthTrackOptions,
): Promise<GrowthAnalyticsTrackResult> {
	// Re-entering a generic editor ends content selection, while pending task snapshots remain valid.
	if (
		typeof event === "object" &&
		event !== null &&
		"name" in event &&
		event.name === "landing_viewed"
	) {
		browserAttributionStore().clearContext();
	}
	browserGrowthAnalyticsDispatcher ??= createBrowserGrowthAnalyticsDispatcher({
		getCookie: () => (typeof document === "undefined" ? "" : (document.cookie ?? "")),
		resolveAnonymousSessionHash: getOrCreateBrowserGrowthAnalyticsSessionHash,
		attribution: browserAttributionStore(),
		isSuppressed: () => browserGrowthAnalyticsSuppressed,
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

function taskKeyForGrowthEvent(
	name: GrowthAnalyticsEventName,
	options?: GrowthTrackOptions,
): string | undefined {
	if (name === "editor_generation_confirmed") return options?.taskKey;
	const prefixes: Partial<Record<GrowthAnalyticsEventName, string>> = {
		editor_generation_succeeded: "editor-generation-succeeded:",
		editor_generation_failed: "editor-generation-failed:",
		guest_generation_admitted: "guest-generation-admitted:",
		guest_result_ready: "guest-result-ready:",
		guest_registered_session_established: "guest-registered-session-established:",
		guest_result_grant_completed: "guest-result-grant-completed:",
	};
	const prefix = prefixes[name];
	return prefix && options?.dedupeKey?.startsWith(prefix)
		? options.dedupeKey.slice(prefix.length)
		: undefined;
}

export async function hashGrowthTaskIdentity(
	sessionHash: string,
	taskKey: string,
): Promise<string | undefined> {
	if (
		!analyticsHashSchema.safeParse(sessionHash).success ||
		!taskKey ||
		typeof crypto === "undefined" ||
		!crypto.subtle
	)
		return undefined;
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${sessionHash}:growth-task:${taskKey}`),
		),
	);
	return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
	if (!hasGrowthAnalyticsConsent(document.cookie ?? "")) return undefined;
	const existing = readGrowthAnalyticsSessionHash(document.cookie);
	if (existing) return existing;
	if (!crypto.getRandomValues || !crypto.subtle) return undefined;
	const random = crypto.getRandomValues(new Uint8Array(32));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", random));
	const hash = `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	if (!hasGrowthAnalyticsConsent(document.cookie ?? "")) return undefined;
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

type EzPicProductKey = (typeof EZPIC_ANALYTICS_PRODUCT_KEYS)[number];
type EzPicPaidPlan = "creator" | "ultimate" | "studio";
type TrackGrowthEvent = (
	event: GrowthAnalyticsEvent,
	options?: GrowthTrackOptions,
) => Promise<GrowthAnalyticsTrackResult>;

export function createSaasGrowthFunnel(track: TrackGrowthEvent = trackBrowserGrowthEvent) {
	return {
		draftClaimed: (key: string, productKey: EzPicProductKey) =>
			track(
				{ name: "draft_claimed", properties: { productKey, status: "claimed" } },
				{ dedupeKey: `draft-claimed:${key}` },
			),
		quoteCreated: (
			key: string,
			productKey: EzPicProductKey,
			credits: number,
			attribution?: GrowthAnalyticsAttributionSnapshot,
		) =>
			track(
				{
					name: "editor_quote_created",
					properties: {
						creditsBucket: bucketGrowthCredits(credits),
						productKey,
						status: "created",
					},
				},
				{ dedupeKey: `editor-quote-created:${key}`, ...(attribution ? { attribution } : {}) },
			),
		generationConfirmed: (
			key: string,
			productKey: EzPicProductKey,
			taskKey?: string,
			attribution?: GrowthAnalyticsAttributionSnapshot,
		) =>
			track(
				{ name: "editor_generation_confirmed", properties: { productKey, status: "confirmed" } },
				{
					dedupeKey: `editor-generation-confirmed:${key}`,
					...(taskKey ? { taskKey } : {}),
					...(attribution ? { attribution } : {}),
				},
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
		guestGenerationAdmitted: (key: string, attribution?: GrowthAnalyticsAttributionSnapshot) =>
			track(
				{ name: "guest_generation_admitted", properties: { status: "admitted" } },
				{ dedupeKey: `guest-generation-admitted:${key}`, ...(attribution ? { attribution } : {}) },
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
