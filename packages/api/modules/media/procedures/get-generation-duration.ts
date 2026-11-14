import { mediaProviderKeySchema, parseMediaEnabledProviders } from "@repo/config";
import { db } from "@repo/database/client";
import {
	generationDurationInputSchema,
	generationDurationOutputSchema,
} from "@repo/database/generation-duration-contract";
import { getGenerationDurationEstimate } from "@repo/database/media-generation-duration";

import { publicProcedure } from "../../../orpc/procedures";

export const getGenerationDuration = publicProcedure
	.route({
		method: "GET",
		path: "/media/generation-duration",
		tags: ["Media"],
		summary: "Read recent completed image task durations",
		description:
			"Aggregated job creation-to-success p50–p90 observations for one public product and SKU. Excludes marked internal tasks; not a remaining-time guarantee.",
	})
	.input(generationDurationInputSchema)
	.output(generationDurationOutputSchema)
	.handler(async ({ input, context }) => {
		// Only aggregate public data is cacheable; never use a user/session-specific key here.
		context.responseHeaders?.set("Cache-Control", "public, max-age=120");
		try {
			if (process.env.NODE_ENV !== "production") return { kind: "processing" as const };
			const enabledProviders = process.env.MEDIA_ENABLED_PROVIDERS;
			const legacyAdapter = process.env.MEDIA_PROVIDER_ADAPTER;
			if (
				parseMediaEnabledProviders({
					MEDIA_ENABLED_PROVIDERS: enabledProviders,
					MEDIA_PROVIDER_ADAPTER:
						enabledProviders !== undefined ||
						legacyAdapter === undefined ||
						legacyAdapter === "mock"
							? "mock"
							: mediaProviderKeySchema.parse(legacyAdapter),
				}).length === 0
			) {
				return { kind: "processing" as const };
			}
			return await getGenerationDurationEstimate(input, db);
		} catch {
			context.responseHeaders?.set("Cache-Control", "no-store");
			return { kind: "processing" as const };
		}
	});
