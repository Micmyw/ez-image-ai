import { resolveAnalyticsPolicy } from "@repo/utils/lib/analytics-policy";
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
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		context.responseHeaders?.set("Vary", "Cookie, CF-IPCountry, X-Vercel-IP-Country, Sec-GPC, DNT");
		return resolveAnalyticsPolicy(context.headers);
	});
