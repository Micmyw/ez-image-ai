import {
	type AdminScope,
	getAdminAnalyticsFunnel,
	getAdminAnalyticsOverview,
	getAdminAnalyticsReport,
} from "@repo/database";

import {
	adminAnalyticsFunnelInputSchema,
	adminAnalyticsFunnelOutputSchema,
	adminAnalyticsOverviewInputSchema,
	adminAnalyticsOverviewOutputSchema,
	adminAnalyticsReportInputSchema,
	adminAnalyticsReportOutputSchema,
} from "./types";

export type AdminAnalyticsOperation =
	| "analytics_overview"
	| "analytics_funnel"
	| "analytics_report";

/** All public transports authorize through the management executor before calling this handler. */
export async function executeAdminAnalyticsOperation(
	operation: AdminAnalyticsOperation,
	input: unknown,
	context: { scope: AdminScope },
) {
	switch (operation) {
		case "analytics_overview": {
			const parsed = adminAnalyticsOverviewInputSchema.parse(input);
			return adminAnalyticsOverviewOutputSchema.parse(
				await getAdminAnalyticsOverview({ ...parsed, scope: context.scope }),
			);
		}
		case "analytics_funnel": {
			const parsed = adminAnalyticsFunnelInputSchema.parse(input);
			return adminAnalyticsFunnelOutputSchema.parse(
				await getAdminAnalyticsFunnel({ ...parsed, scope: context.scope }),
			);
		}
		case "analytics_report": {
			const parsed = adminAnalyticsReportInputSchema.parse(input);
			const to = parsed.to ? new Date(parsed.to) : new Date();
			const from = parsed.from ? new Date(parsed.from) : new Date(to.getTime() - 86_400_000);
			return adminAnalyticsReportOutputSchema.parse(
				await getAdminAnalyticsReport({
					scope: context.scope,
					from,
					to,
					compare: parsed.compare,
					environment: parsed.environment,
				}),
			);
		}
	}
}
