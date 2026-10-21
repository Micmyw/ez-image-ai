import { ORPCError } from "@orpc/server";
import { recordAggregateTraffic } from "@repo/database";
import { AGGREGATE_PATHS, AGGREGATE_SOURCES } from "@repo/utils/lib/aggregate-traffic";
import { analyticsDevice } from "@repo/utils/lib/analytics-dimensions";
import { hasAnalyticsPrivacySignal } from "@repo/utils/lib/analytics-policy";
import { z } from "zod";

import { publicProcedure } from "../../orpc/procedures";

export const ingestAggregateTraffic = publicProcedure
	.route({
		method: "POST",
		path: "/analytics/traffic",
		tags: ["Analytics"],
		summary: "Increment an anonymous page counter",
		description:
			"Finite hourly totals only. No cookies, account lookup, visit rows or visitor identity.",
	})
	.input(z.object({ path: z.enum(AGGREGATE_PATHS), source: z.enum(AGGREGATE_SOURCES) }).strict())
	.output(z.object({ accepted: z.boolean() }))
	.handler(async ({ context, input }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		const origin = new URL(process.env.NEXT_PUBLIC_SAAS_URL || "http://localhost:3000").origin;
		if (context.headers.get("origin") !== origin) throw new ORPCError("FORBIDDEN");
		// The browser intentionally omits credentials; reject accidental credentialed collection.
		if (
			context.headers.has("cookie") ||
			context.headers.has("authorization") ||
			hasAnalyticsPrivacySignal(context.headers)
		)
			return { accepted: false };
		const agent = context.headers.get("user-agent") ?? "";
		if (/bot|spider|crawler|headless/i.test(agent)) return { accepted: false };
		return recordAggregateTraffic({ ...input, device: analyticsDevice(agent) });
	});
