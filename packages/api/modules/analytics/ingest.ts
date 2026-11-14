import { ORPCError } from "@orpc/server";
import { auth } from "@repo/auth";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { growthExperimentVariant } from "@repo/config/growth-experiments";
import { recordGrowthEvent } from "@repo/database";
import {
	firstTouchAttributionSchema,
	sanitizeFirstTouchAttribution,
} from "@repo/utils/lib/acquisition-attribution";
import { acquisitionSource, analyticsDevice } from "@repo/utils/lib/analytics-dimensions";
import {
	growthAnalyticsPath,
	isAuthenticationAnalyticsPath,
	publicAnalyticsPath,
	sanitizeGrowthAnalyticsPath,
} from "@repo/utils/lib/analytics-page";
import { resolveAnalyticsPolicy } from "@repo/utils/lib/analytics-policy";
import {
	growthAnalyticsEventSchema,
	containsSensitiveAnalyticsData,
} from "@repo/utils/lib/growth-analytics";
import {
	hasGrowthAnalyticsConsent,
	readGrowthAnalyticsSessionHash,
} from "@repo/utils/lib/growth-analytics-cookie";
import { z } from "zod";

import { publicProcedure } from "../../orpc/procedures";
import { growthDiagnosticProjection } from "./diagnostic-projection";

export const ingestGrowthEvent = publicProcedure
	.route({
		method: "POST",
		path: "/analytics/events",
		tags: ["Analytics"],
		summary: "Record a consented browser observation",
		description:
			"Allowlisted observations only. Identity, time and device are resolved on the server; never confirms payment.",
	})
	.input(
		z
			.object({
				id: z.uuid(),
				event: growthAnalyticsEventSchema,
				firstTouch: firstTouchAttributionSchema.optional(),
				path: z.string().max(256).nullable(),
			})
			.strict()
			.refine((value) => JSON.stringify(value).length <= 4096),
	)
	.output(z.object({ accepted: z.boolean() }))
	.handler(async ({ input, context }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		const origin = new URL(process.env.NEXT_PUBLIC_SAAS_URL || "http://localhost:3000").origin;
		if (context.headers.get("origin") !== origin) throw new ORPCError("FORBIDDEN");
		const cookie = context.headers.get("cookie") ?? "";
		if (
			/prefetch|prerender/i.test(
				`${context.headers.get("purpose") ?? ""} ${context.headers.get("sec-purpose") ?? ""}`,
			) ||
			context.headers.get("next-router-prefetch") === "1"
		)
			return { accepted: false };
		const sessionHash = readGrowthAnalyticsSessionHash(cookie);
		if (
			!resolveAnalyticsPolicy(context.headers).analyticsAllowed ||
			!hasGrowthAnalyticsConsent(cookie) ||
			!sessionHash
		)
			return { accepted: false };
		if (
			sessionHash !== input.event.properties.anonymousSessionHash ||
			containsSensitiveAnalyticsData(input.event)
		)
			throw new ORPCError("BAD_REQUEST");
		const session = await auth.api.getSession({ headers: context.headers });
		const user = session?.user && !isAnonymousUser(session.user) ? session.user : null;
		const experiment = input.event.properties.experiment;
		if (
			experiment &&
			experiment.variant !== growthExperimentVariant(experiment.experimentId, sessionHash)
		)
			throw new ORPCError("BAD_REQUEST");
		const firstTouch = sanitizeFirstTouchAttribution(input.firstTouch, origin);
		const path = input.path ? sanitizeGrowthAnalyticsPath(input.path, origin) : null;
		if (
			input.event.properties.journey?.stage === "auth_viewed" &&
			!isAuthenticationAnalyticsPath(path)
		)
			return { accepted: false };
		if (
			input.event.name === "page_viewed" &&
			(!path || !publicAnalyticsPath(new URL(path, origin)))
		)
			return { accepted: false };
		const agent = context.headers.get("user-agent") ?? "";
		if (/bot|spider|crawler|headless/i.test(agent)) return { accepted: false };
		return recordGrowthEvent({
			id: input.id,
			sessionHash,
			userId: user?.id ?? null,
			internal: user?.role === "admin" || Boolean(session?.session.impersonatedBy),
			name: input.event.name,
			path: path ? growthAnalyticsPath(new URL(path, origin)) : null,
			source: acquisitionSource(firstTouch),
			medium: firstTouch?.utmMedium ?? null,
			campaign: firstTouch?.utmCampaign ?? null,
			device: analyticsDevice(agent),
			productKind: input.event.properties.productKind ?? null,
			errorCategory: input.event.properties.errorCategory ?? null,
			diagnostics: growthDiagnosticProjection(input.event),
		});
	});
