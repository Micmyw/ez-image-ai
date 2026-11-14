import {
	GENERATION_JOURNEY_OBSERVED,
	generationJourneyObservationSchema,
	type GenerationJourneyObservation,
} from "@repo/config/generation-journey";
import { browserAnalyticsPrivacySignal } from "@repo/utils/lib/analytics-policy";
import {
	growthConsentRevision,
	trackBrowserGrowthEvent,
} from "@repo/utils/lib/growth-analytics-browser";
import { hasGrowthAnalyticsConsent } from "@repo/utils/lib/growth-analytics-cookie";

export type JourneyObservationInput = Omit<GenerationJourneyObservation, "version">;
type JourneyJob = { jobKey: string; actionRef?: string; draftRef?: string; startedAt: number };
const journeyJobs = new Map<string, JourneyJob & { consentRevision: number }>();
const JOB_TIMING_TTL_MS = 30 * 60_000;

/** Same-document monotonic click time only; refreshes and auth redirects leave timing unknown. */
export function rememberJourneyJob(input: JourneyJob) {
	try {
		if (
			typeof document === "undefined" ||
			!hasGrowthAnalyticsConsent(document.cookie) ||
			browserAnalyticsPrivacySignal()
		) {
			journeyJobs.clear();
			return;
		}
		const now = performance.now();
		for (const [key, value] of journeyJobs)
			if (now - value.startedAt > JOB_TIMING_TTL_MS) journeyJobs.delete(key);
		if (
			!input.jobKey ||
			!Number.isFinite(input.startedAt) ||
			input.startedAt < 0 ||
			input.startedAt > now ||
			now - input.startedAt > JOB_TIMING_TTL_MS ||
			journeyJobs.has(input.jobKey)
		)
			return;
		journeyJobs.set(input.jobKey, { ...input, consentRevision: growthConsentRevision() });
		while (journeyJobs.size > 20) journeyJobs.delete(journeyJobs.keys().next().value!);
	} catch {
		/* Optional in-memory timing must not affect job presentation. */
	}
}

/** Call from the existing decoded image + viewport visibility observer, not URL retrieval. */
export async function trackJourneyResultVisible(jobKey: string) {
	try {
		const stored = journeyJobs.get(jobKey);
		const timing = stored?.consentRevision === growthConsentRevision() ? stored : undefined;
		const elapsed = timing ? performance.now() - timing.startedAt : undefined;
		const valid = elapsed !== undefined && elapsed >= 0 && elapsed <= JOB_TIMING_TTL_MS;
		return await trackGenerationJourney(
			{
				stage: "result_visible",
				...(timing?.actionRef ? { actionRef: timing.actionRef } : {}),
				...(timing?.draftRef ? { draftRef: timing.draftRef } : {}),
				...(valid
					? { elapsedMs: Math.round(elapsed), latencyBoundary: "generate_to_visible" as const }
					: {}),
			},
			{ jobKey, dedupeKey: `journey:result-visible:${jobKey}` },
		);
	} catch {
		return "failed" as const;
	}
}

/** Optional, random correlation only. Business work must proceed when this is absent. */
export function createJourneyReference(): string | undefined {
	try {
		return typeof document !== "undefined" &&
			hasGrowthAnalyticsConsent(document.cookie) &&
			!browserAnalyticsPrivacySignal()
			? crypto.randomUUID()
			: undefined;
	} catch {
		return undefined;
	}
}

/** Visibility comes from mounted UI / the existing decoded-preview visibility callback. */
export async function trackGenerationJourney(
	input: JourneyObservationInput,
	options?: { jobKey?: string; dedupeKey?: string },
) {
	try {
		if (
			typeof document === "undefined" ||
			browserAnalyticsPrivacySignal() ||
			!hasGrowthAnalyticsConsent(document.cookie)
		) {
			journeyJobs.clear();
			return "blocked" as const;
		}
		if (
			["auth_viewed", "result_visible", "purchase_offer_viewed"].includes(input.stage) &&
			(document.visibilityState !== "visible" ||
				("prerendering" in document && document.prerendering === true))
		)
			return "blocked" as const;
		const parsed = generationJourneyObservationSchema.safeParse({ ...input, version: 1 });
		if (!parsed.success) return "rejected" as const;
		const identity = input.actionRef ?? input.draftRef;
		return await trackBrowserGrowthEvent(
			{ name: GENERATION_JOURNEY_OBSERVED, properties: { journey: parsed.data } },
			{
				...(options?.jobKey ? { taskKey: options.jobKey } : {}),
				...(options?.dedupeKey || identity
					? { dedupeKey: options?.dedupeKey ?? `journey:v1:${input.stage}:${identity}` }
					: {}),
			},
		);
	} catch {
		return "failed" as const;
	}
}
