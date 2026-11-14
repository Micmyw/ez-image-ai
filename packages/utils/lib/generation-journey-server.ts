import {
	GENERATION_JOURNEY_CONFIRMED,
	generationJourneyConfirmationSchema,
	generationJourneyRefsSchema,
	type GenerationJourneyConfirmation,
	type GenerationJourneyRefs,
} from "@repo/config/generation-journey";

import { ATTRIBUTION_COOKIE_NAME, sanitizeFirstTouchAttribution } from "./acquisition-attribution";
import { acquisitionSource, analyticsDevice } from "./analytics-dimensions";
import { resolveAnalyticsPolicy } from "./analytics-policy";
import {
	hasGrowthAnalyticsConsent,
	readGrowthAnalyticsSessionHash,
} from "./growth-analytics-cookie";

type ConfirmationInput = {
	headers: Headers;
	stage: GenerationJourneyConfirmation["stage"];
	/** Trusted persisted identity only. This value is hashed and is never stored in diagnostics. */
	entityKey: string;
	refs?: GenerationJourneyRefs;
	user?: { id: string; isAnonymous?: boolean | null; role?: string | null } | null;
	impersonated?: boolean;
	authMethod?: GenerationJourneyConfirmation["authMethod"];
	feedbackTopic?: GenerationJourneyConfirmation["feedbackTopic"];
};
type ConfirmationRecord = {
	id: string;
	sessionHash: string;
	userId: string | null;
	internal: boolean;
	name: string;
	path: null;
	source: string | null;
	medium: string | null;
	campaign: string | null;
	device: string;
	productKind: null;
	errorCategory: null;
	diagnostics: Record<string, string | number | boolean>;
};

async function hash(value: string) {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
	return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Invoke only after the owning server operation commits. Never call this from public ingestion.
 * Optional diagnostics failure is contained and cannot roll back or replay business work.
 */
export async function persistGenerationJourneyConfirmation(
	input: ConfirmationInput,
	dependencies: { save: (event: ConfirmationRecord) => Promise<unknown> },
): Promise<boolean> {
	try {
		const cookie = input.headers.get("cookie") ?? "";
		const sessionHash = readGrowthAnalyticsSessionHash(cookie);
		if (
			!sessionHash ||
			!hasGrowthAnalyticsConsent(cookie) ||
			!resolveAnalyticsPolicy(input.headers).analyticsAllowed ||
			!input.entityKey
		)
			return false;
		if (
			input.stage === "auth_session_established" &&
			(!input.user?.id || input.user.isAnonymous !== false)
		)
			return false;
		const refs = generationJourneyRefsSchema.safeParse(input.refs ?? {});
		if (!refs.success) return false;
		let attribution = null;
		try {
			const value = cookie
				.split(";")
				.map((part) => part.trim())
				.find((part) => part.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`))
				?.slice(ATTRIBUTION_COOKIE_NAME.length + 1);
			if (value && value.length <= 4096)
				attribution = sanitizeFirstTouchAttribution(
					JSON.parse(decodeURIComponent(value)),
					new URL(process.env.NEXT_PUBLIC_SAAS_URL || "http://localhost:3000").origin,
				);
		} catch {
			/* Optional attribution cannot affect a confirmed business operation. */
		}
		const entityHash = await hash(`${sessionHash}:journey:v1:${input.stage}:${input.entityKey}`);
		const diagnostics = generationJourneyConfirmationSchema.parse({
			version: 1,
			stage: input.stage,
			entityHash,
			...refs.data,
			...(input.stage === "job_admitted"
				? { jobHash: await hash(`${sessionHash}:growth-task:${input.entityKey}`) }
				: {}),
			...(input.authMethod ? { authMethod: input.authMethod } : {}),
			...(input.feedbackTopic ? { feedbackTopic: input.feedbackTopic } : {}),
		});
		const result = await dependencies.save({
			id: `journey:v1:${input.stage}:${entityHash}`,
			sessionHash,
			userId: input.user && input.user.isAnonymous === false ? input.user.id : null,
			internal: input.user?.role === "admin" || input.impersonated === true,
			name: GENERATION_JOURNEY_CONFIRMED,
			path: null,
			source: acquisitionSource(attribution),
			medium: attribution?.utmMedium ?? null,
			campaign: attribution?.utmCampaign ?? null,
			device: analyticsDevice(input.headers.get("user-agent") ?? ""),
			productKind: null,
			errorCategory: null,
			diagnostics,
		});
		return !(
			result &&
			typeof result === "object" &&
			"accepted" in result &&
			result.accepted === false
		);
	} catch {
		return false;
	}
}
