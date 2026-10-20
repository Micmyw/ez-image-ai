import { sql } from "drizzle-orm";

import {
	assertAdminAnalyticsReportPeriod,
	buildAdminAnalyticsFunnel,
	buildAdminAnalyticsOverview,
	buildAdminAnalyticsReport,
	type AdminAnalyticsEnvironment,
	type AdminAnalyticsFunnelInput,
	type AdminAnalyticsReportInput,
} from "../../shared/admin-analytics";
import { readAdminAnalyticsFacts } from "../../shared/admin-analytics-reader";
import type { AdminScope } from "../../shared/admin-scope";
import { db } from "../client";

const readFacts = (scope: AdminScope) =>
	db.transaction(
		async (transaction) =>
			readAdminAnalyticsFacts(async <T>(statement: string, parameters: readonly unknown[]) => {
				const segments = statement.split(/(\$\d+)/g).map((segment) => {
					const match = /^\$(\d+)$/.exec(segment);
					return match ? sql`${parameters[Number(match[1]) - 1]}` : sql.raw(segment);
				});
				const result = await transaction.execute(sql.join(segments, sql.raw("")));
				return result.rows as T[];
			}, scope),
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);

export async function getAdminAnalyticsOverview(input: {
	scope: AdminScope;
	now?: Date;
	environment?: AdminAnalyticsEnvironment;
}) {
	return buildAdminAnalyticsOverview(
		await readFacts(input.scope),
		input.scope,
		input.now,
		input.environment,
	);
}
export async function getAdminAnalyticsFunnel(input: AdminAnalyticsFunnelInput) {
	return buildAdminAnalyticsFunnel(await readFacts(input.scope), input);
}
export async function getAdminAnalyticsReport(input: AdminAnalyticsReportInput) {
	assertAdminAnalyticsReportPeriod(input.from, input.to);
	return buildAdminAnalyticsReport(await readFacts(input.scope), input);
}
