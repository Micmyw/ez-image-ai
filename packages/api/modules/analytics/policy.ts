import {
	resolveAnalyticsPolicy,
	setAnalyticsPolicyPrivacyHeaders,
} from "@repo/utils/lib/analytics-policy";
import { z } from "zod";

import { publicProcedure } from "../../orpc/procedures";

export const getAnalyticsPolicy = publicProcedure
	.route({
		method: "GET",
		path: "/analytics/policy",
		tags: ["Analytics"],
		summary: "Read this request's analytics policy",
		description: "Uncached trusted-region policy; no visitor identifier is created.",
	})
	.output(
		z.object({
			requiresOptIn: z.boolean(),
			privacySignal: z.boolean(),
			analyticsAllowed: z.boolean(),
		}),
	)
	.handler(({ context }) => {
		if (context.responseHeaders) setAnalyticsPolicyPrivacyHeaders(context.responseHeaders);
		return resolveAnalyticsPolicy(context.headers);
	});
