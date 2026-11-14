import { z } from "zod";

import { EZPIC_PRODUCT_KEYS } from "./client";

/** Versioned diagnostic references. They are never authentication or admission identities. */
export const generationJourneyRefsSchema = z
	.object({
		actionRef: z.uuid().optional(),
		draftRef: z.uuid().optional(),
	})
	.strict();
/** Discard malformed optional telemetry at business boundaries instead of rejecting the action. */
export const optionalGenerationJourneyRefsSchema = generationJourneyRefsSchema
	.optional()
	.catch(undefined);

export const GENERATION_JOURNEY_OBSERVED = "generation_journey_observed_v1";
export const GENERATION_JOURNEY_CONFIRMED = "generation_journey_confirmed_v1";
export const JOURNEY_OBSERVATION_STAGES = [
	"source_selected",
	"upload_started",
	"upload_completed",
	"upload_failed",
	"generate_clicked",
	"quote_observed",
	"job_admitted_observed",
	"generation_failed_observed",
	"auth_viewed",
	"auth_started",
	"auth_cancelled",
	"auth_session_observed",
	"draft_saved",
	"draft_restored",
	"draft_restore_failed",
	"result_visible",
	"refine_started",
	"purchase_offer_viewed",
	"feedback_opened",
	"feedback_email_opened",
	"feedback_submitted_observed",
] as const;
export const JOURNEY_CONFIRMATION_STAGES = [
	"upload_sealed",
	"draft_claimed",
	"job_admitted",
	"auth_session_established",
	"feedback_received",
] as const;
export const JOURNEY_FEEDBACK_TOPICS = [
	"result",
	"waiting",
	"upload",
	"login",
	"price_credits",
	"other",
] as const;
export const generationJourneyHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const generationJourneyDetailsSchema = generationJourneyRefsSchema
	.extend({
		version: z.literal(1),
		jobHash: generationJourneyHashSchema.optional(),
		entityHash: generationJourneyHashSchema.optional(),
		publicModel: z.enum(EZPIC_PRODUCT_KEYS).optional(),
		authMethod: z.enum(["google", "email", "magic_link", "google_one_tap", "unknown"]).optional(),
		reason: z
			.enum([
				"input_required",
				"policy_rejected",
				"insufficient_credits",
				"capacity",
				"unavailable",
				"network",
				"cancelled",
				"expired",
				"unknown",
			])
			.optional(),
		elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
		latencyBoundary: z.enum(["generate_to_visible", "upload", "auth", "unknown"]).optional(),
		feedbackTopic: z.enum(JOURNEY_FEEDBACK_TOPICS).optional(),
	})
	.strict();
export const generationJourneyObservationSchema = generationJourneyDetailsSchema
	.extend({
		stage: z.enum(JOURNEY_OBSERVATION_STAGES),
	})
	.strict()
	.refine((value) => value.entityHash === undefined);
export const generationJourneyConfirmationSchema = generationJourneyDetailsSchema
	.extend({
		stage: z.enum(JOURNEY_CONFIRMATION_STAGES),
		entityHash: generationJourneyHashSchema,
	})
	.strict();
export type GenerationJourneyObservation = z.infer<typeof generationJourneyObservationSchema>;
export type GenerationJourneyConfirmation = z.infer<typeof generationJourneyConfirmationSchema>;
export type GenerationJourneyRefs = z.infer<typeof generationJourneyRefsSchema>;

const count = z.number().int().nonnegative();
export const generationJourneyReportSchema = z.object({
	version: z.literal(1),
	observedEvents: count,
	confirmedEvents: count,
	clicks: count,
	drafts: count,
	admittedJobs: count,
	linkedClicks: count,
	unlinkedClicks: count,
	ambiguousClicks: count,
	jobsWithoutClick: count,
	unkeyedObservations: count,
	invalidEvents: count,
	legacyEvents: count,
	stages: z.array(
		z.object({
			stage: z.string(),
			evidence: z.enum(["observed", "confirmed"]),
			events: count,
			identities: count,
			unkeyed: count,
		}),
	),
	visibleLatency: z.object({
		samples: count,
		excluded: count,
		p50Ms: z.number().nonnegative().nullable(),
		p90Ms: z.number().nonnegative().nullable(),
	}),
});
export type GenerationJourneyReport = z.infer<typeof generationJourneyReportSchema>;
