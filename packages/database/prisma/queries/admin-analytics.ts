import {
	buildAdminAnalyticsFunnel,
	buildAdminAnalyticsOverview,
	buildAdminAnalyticsReport,
	assertAdminAnalyticsReportPeriod,
	type AdminAnalyticsEnvironment,
	type AdminAnalyticsFunnelInput,
	type AdminAnalyticsReportInput,
} from "../../shared/admin-analytics";
import { readAdminAnalyticsFacts } from "../../shared/admin-analytics-reader";
import type { AdminScope } from "../../shared/admin-scope";
import { db } from "../client";

// SQL is authored in admin-analytics-reader; values are positional parameters.
const readFacts = (scope: AdminScope) =>
	db.$transaction(
		(transaction) =>
			readAdminAnalyticsFacts(
				(statement, parameters) => transaction.$queryRawUnsafe(statement, ...parameters),
				scope,
			),
		{ isolationLevel: "RepeatableRead", timeout: 30_000 },
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
