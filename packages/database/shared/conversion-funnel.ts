import { EXPERIMENT_RETENTION_MS } from "@repo/config/growth-experiments";

import {
	ADMIN_ANALYTICS_RANGES,
	type AdminAnalyticsFacts,
	type AdminAnalyticsRange,
} from "./admin-analytics";
import type { AdminAnalyticsQuery } from "./admin-analytics-reader";
import { readAggregateTraffic, aggregateTrafficSince } from "./aggregate-traffic";
import { buildConversionActivity } from "./conversion-activity";
import { buildConversionExperiments } from "./conversion-experiments";
import type { GrowthEventInput } from "./growth-events";

export interface ConversionInput {
	range: AdminAnalyticsRange;
	source?: string;
	device?: string;
	now?: Date;
}
export interface ConversionEvent extends GrowthEventInput {
	createdAt: Date;
}
export interface ConversionJob {
	id: string;
	userId: string;
	createdAt: Date;
	terminalAt: Date | null;
	status: string;
	failureCode: string | null;
	inputRejected: boolean;
}

export function registrationSource(value: unknown): string {
	if (!value || typeof value !== "object") return "unknown";
	const v = value as Record<string, unknown>;
	if (v.version !== 1 || typeof v.registeredAt !== "string") return "unknown";
	if (typeof v.utmSource === "string" && /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(v.utmSource))
		return v.utmSource.toLowerCase();
	if (typeof v.referrerOrigin === "string") {
		try {
			return new URL(v.referrerOrigin).hostname.replace(/^www\./, "");
		} catch {
			/* unknown */
		}
	}
	return v.source === "direct" ? "direct" : "unknown";
}

export const CONVERSION_SQL = {
	events: `SELECT * FROM growth_event WHERE "createdAt" >= $1 AND "createdAt" < $2 ORDER BY "createdAt", id LIMIT 20001`,
	jobs: `SELECT j.id, j."submittedByUserId" AS "userId", j."createdAt", j."terminalAt", j.status::text, j."failureCode",
		EXISTS (SELECT 1 FROM generation_job_asset b JOIN LATERAL
			(SELECT m.status FROM asset_moderation_result m WHERE m."assetId" = b."assetId"
				AND (b."assetChecksum" IS NULL OR m."assetChecksum" = b."assetChecksum")
				AND m."createdAt" <= COALESCE(j."terminalAt", $2)
				ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1) review ON true
			WHERE b."jobId" = j.id AND b.role = 'INPUT' AND review.status = 'REJECTED') AS "inputRejected"
		FROM generation_job j WHERE j."createdAt" >= $1 AND j."createdAt" < $2 ORDER BY j."createdAt", j.id LIMIT 20001`,
};

export async function readConversionObservations(
	query: AdminAnalyticsQuery,
	input: ConversionInput,
) {
	const to = input.now ?? new Date();
	const from = new Date(to.getTime() - ADMIN_ANALYTICS_RANGES[input.range]);
	const [events, jobs, aggregateTraffic] = await Promise.all([
		query<ConversionEvent>(CONVERSION_SQL.events, [
			new Date(to.getTime() - EXPERIMENT_RETENTION_MS),
			to,
		]),
		query<ConversionJob>(CONVERSION_SQL.jobs, [from, to]),
		readAggregateTraffic(query, input),
	]);
	if (events.length > 20_000 || jobs.length > 20_000)
		throw new Error("ADMIN_ANALYTICS_DATASET_LIMIT");
	return {
		aggregateTraffic,
		events: events.map((e) => ({ ...e, createdAt: new Date(e.createdAt) })),
		jobs: jobs.map((j) => ({
			...j,
			createdAt: new Date(j.createdAt),
			terminalAt: j.terminalAt ? new Date(j.terminalAt) : null,
		})),
	};
}

/** Open registration cohort: steps are optional activities, not assumed consecutive transitions. */
export function buildConversionFunnel(
	facts: AdminAnalyticsFacts,
	observations: {
		events: ConversionEvent[];
		jobs: ConversionJob[];
		aggregateTraffic?: Awaited<ReturnType<typeof readAggregateTraffic>>;
	},
	input: ConversionInput,
) {
	const to = input.now ?? new Date();
	const from = new Date(to.getTime() - ADMIN_ANALYTICS_RANGES[input.range]);
	const within = (date: Date) => date >= from && date < to;
	const internalUsers = new Set(facts.users.filter((u) => u.role === "admin").map((u) => u.id));
	const internalSessions = new Set(
		observations.events
			.filter((e) => e.internal || (e.userId && internalUsers.has(e.userId)))
			.map((e) => e.sessionHash),
	);
	const events = observations.events.filter(
		(e) => within(e.createdAt) && !internalSessions.has(e.sessionHash),
	);
	const matches = (source: string, device: string) =>
		(!input.source || source === input.source) && (!input.device || device === input.device);
	const deviceByUser = new Map<string, string>();
	for (const e of events)
		if (e.userId && !deviceByUser.has(e.userId)) deviceByUser.set(e.userId, e.device);
	const allCustomers = facts.users.filter(
		(u) => !u.isAnonymous && !u.legacyGuest && u.role !== "admin",
	);
	const cohort = allCustomers.filter((u) => within(u.createdAt));
	const users = cohort.filter((u) =>
		matches(registrationSource(u.registrationAttribution), deviceByUser.get(u.id) ?? "unknown"),
	);
	const countUsers = (ids: Set<string>) => users.filter((u) => ids.has(u.id)).length;
	const ids = new Set(users.map((u) => u.id));
	const joined = new Map(users.map((u) => [u.id, u.createdAt]));
	const jobs = observations.jobs.filter(
		(j) => ids.has(j.userId) && j.createdAt >= joined.get(j.userId)! && within(j.createdAt),
	);
	const cohortEvents = events.filter(
		(e) => e.userId && ids.has(e.userId) && e.createdAt >= joined.get(e.userId)!,
	);
	const reached = (name: string) =>
		new Set(cohortEvents.filter((e) => e.name === name).map((e) => e.userId!));
	const generated = new Set(jobs.map((j) => j.userId));
	const succeeded = new Set(
		jobs
			.filter((j) => j.status === "SUCCEEDED" && j.terminalAt && j.terminalAt < to)
			.map((j) => j.userId),
	);
	const checkouts = facts.checkouts.filter(
		(c) =>
			c.userId && ids.has(c.userId) && c.createdAt >= joined.get(c.userId)! && c.createdAt < to,
	);
	const payments = facts.payments.filter(
		(p) =>
			p.userId &&
			ids.has(p.userId) &&
			p.environment === "production" &&
			p.evidence === "verified" &&
			p.renewal === false &&
			p.amountMicros !== null &&
			p.amountMicros > 0n &&
			p.paidAt &&
			p.paidAt >= joined.get(p.userId)! &&
			p.paidAt < to,
	);
	const checkoutUsers = new Set(checkouts.map((c) => c.userId!));
	const paidUsers = new Set(payments.map((p) => p.userId!));
	const clickUsers = reached("purchase_clicked");
	const totals = {
		signups: users.length,
		generated: generated.size,
		succeeded: succeeded.size,
		purchaseClicked: countUsers(clickUsers),
		checkoutRequested: countUsers(reached("checkout_requested")),
		checkoutRedirected: countUsers(reached("checkout_redirected")),
		checkoutFailed: countUsers(reached("checkout_failed")),
		checkouts: checkoutUsers.size,
		paid: paidUsers.size,
	};
	const firstJobs = new Map<string, ConversionJob>();
	for (const job of [...jobs].sort(
		(a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
	))
		if (!firstJobs.has(job.userId)) firstJobs.set(job.userId, job);
	const failureCounts = new Map<string, number>();
	for (const job of jobs.filter(
		(j) => j.status === "FAILED" && j.terminalAt && j.terminalAt < to,
	)) {
		const code =
			job.inputRejected &&
			["NO_USABLE_OUTPUT", "CONTENT_NOT_ALLOWED"].includes(job.failureCode ?? "")
				? "INPUT_CONTENT_REJECTED"
				: job.failureCode === "PROVIDER_POLICY_REJECTED_NO_CHARGE"
					? "PROVIDER_CONTENT_REJECTED"
					: job.failureCode === "GENERATION_TIMEOUT"
						? "GENERATION_TIMEOUT"
						: "OTHER";
		failureCounts.set(code, (failureCounts.get(code) ?? 0) + 1);
	}
	const pageEvents = events.filter(
		(e) => e.name === "page_viewed" && matches(e.source ?? "unknown", e.device),
	);
	const productEvents = events.filter((e) => matches(e.source ?? "unknown", e.device));
	const firstPageByBrowser = new Map<string, Date>();
	for (const event of pageEvents) {
		const previous = firstPageByBrowser.get(event.sessionHash);
		if (!previous || event.createdAt < previous)
			firstPageByBrowser.set(event.sessionHash, event.createdAt);
	}
	const registrationDates = new Map(cohort.map((user) => [user.id, user.createdAt]));
	const registeredBrowsers = new Map<string, Set<string>>();
	for (const event of events) {
		if (
			event.name !== "registration_confirmed" ||
			!event.userId ||
			event.id !== `registration:${event.userId}`
		)
			continue;
		const registeredAt = registrationDates.get(event.userId);
		const firstPage = firstPageByBrowser.get(event.sessionHash);
		if (!registeredAt || !firstPage || firstPage > registeredAt || event.createdAt < registeredAt)
			continue;
		const accounts = registeredBrowsers.get(event.sessionHash) ?? new Set<string>();
		accounts.add(event.userId);
		registeredBrowsers.set(event.sessionHash, accounts);
	}
	const confirmedPayers = new Set(
		facts.payments
			.filter(
				(p) =>
					p.userId &&
					registrationDates.has(p.userId) &&
					p.evidence === "verified" &&
					p.environment === "production" &&
					p.renewal === false &&
					p.amountMicros !== null &&
					p.amountMicros > 0n &&
					p.paidAt &&
					p.paidAt >= registrationDates.get(p.userId)! &&
					p.paidAt < to,
			)
			.map((p) => p.userId!),
	);
	const successfulCustomers = new Set(
		observations.jobs
			.filter(
				(j) =>
					registrationDates.has(j.userId) &&
					j.createdAt >= registrationDates.get(j.userId)! &&
					j.status === "SUCCEEDED" &&
					j.terminalAt &&
					j.terminalAt < to,
			)
			.map((j) => j.userId),
	);
	const reachedByBrowser = (customers: Set<string>) =>
		[...registeredBrowsers.values()].filter((ids) => [...ids].some((id) => customers.has(id)))
			.length;
	const sourceValues = new Set([
		...cohort.map((u) => registrationSource(u.registrationAttribution)),
		...events.filter((e) => e.name === "page_viewed").map((e) => e.source ?? "unknown"),
	]);
	const rows = [...sourceValues]
		.sort()
		.filter((source) => !input.source || source === input.source)
		.map((source) => {
			const group = users.filter((u) => registrationSource(u.registrationAttribution) === source);
			return {
				source,
				browsers: new Set(
					pageEvents.filter((e) => (e.source ?? "unknown") === source).map((e) => e.sessionHash),
				).size,
				signups: group.length,
				generated: group.filter((u) => generated.has(u.id)).length,
				succeeded: group.filter((u) => succeeded.has(u.id)).length,
				purchaseClicked: group.filter((u) => clickUsers.has(u.id)).length,
				checkouts: group.filter((u) => checkoutUsers.has(u.id)).length,
				paid: group.filter((u) => paidUsers.has(u.id)).length,
			};
		});
	const productKinds = ["PLAN", "CREDIT_PACK", "IMAGE_PASS"];
	const generationGroups = new Map<
		string,
		{
			mediaKind: string;
			phase: string;
			publicModel: string | null;
			textLength: string | null;
			inputCount: number | null;
			reason: string | null;
			observations: number;
		}
	>();
	for (const event of productEvents) {
		const d = event.diagnostics;
		if (
			!d ||
			!["generation_input_observed", "generation_action_observed"].includes(event.name) ||
			!["image", "video"].includes(String(d.mediaKind))
		)
			continue;
		const row = {
			mediaKind: String(d.mediaKind),
			phase: String(d.phase),
			publicModel: typeof d.publicModel === "string" ? d.publicModel : null,
			textLength: typeof d.textLength === "string" ? d.textLength : null,
			inputCount: typeof d.inputCount === "number" ? d.inputCount : null,
			reason: typeof d.reason === "string" ? d.reason : null,
			observations: 0,
		};
		const key = JSON.stringify(row);
		const existing = generationGroups.get(key) ?? row;
		existing.observations++;
		generationGroups.set(key, existing);
	}
	const checkoutFailures = new Map<string, number>();
	for (const event of productEvents.filter((e) => e.name === "checkout_failed")) {
		const category = event.errorCategory ?? "unknown";
		checkoutFailures.set(category, (checkoutFailures.get(category) ?? 0) + 1);
	}
	return {
		since: from.toISOString(),
		asOf: to.toISOString(),
		experiments: buildConversionExperiments(facts, observations.events, from, to, input),
		activity: buildConversionActivity(facts, events, observations.jobs, from, to, input),
		aggregateTraffic: observations.aggregateTraffic ?? {
			since: aggregateTrafficSince(input).toISOString(),
			views: 0,
			sources: [],
		},
		totals,
		rows,
		checkoutFailures: [...checkoutFailures].map(([category, events]) => ({ category, events })),
		generationObservations: [...generationGroups.values()]
			.sort((a, b) => b.observations - a.observations)
			.slice(0, 50),
		sources: [...sourceValues].sort(),
		traffic: {
			browsers: new Set(pageEvents.map((e) => e.sessionHash)).size,
			pageViews: pageEvents.length,
		},
		visitorCohort: {
			registeredBrowsers: registeredBrowsers.size,
			successfulBrowsers: reachedByBrowser(successfulCustomers),
			paidBrowsers: reachedByBrowser(confirmedPayers),
			registrationRate: firstPageByBrowser.size
				? registeredBrowsers.size / firstPageByBrowser.size
				: null,
		},
		coverage: {
			unknownSourceUsers: users.filter(
				(u) => registrationSource(u.registrationAttribution) === "unknown",
			).length,
			usersWithBrowserEvents: new Set(
				cohortEvents.filter((e) => e.name !== "registration_confirmed").map((e) => e.userId),
			).size,
			internalBrowsersExcluded: internalSessions.size,
			firstObservedAt:
				events.find((e) => e.name !== "registration_confirmed")?.createdAt.toISOString() ?? null,
		},
		firstAttempt: {
			attempted: firstJobs.size,
			succeeded: [...firstJobs.values()].filter((j) => j.status === "SUCCEEDED").length,
			failed: [...firstJobs.values()].filter((j) => j.status === "FAILED").length,
		},
		failures: [...failureCounts].map(([reason, jobs]) => ({ reason, jobs })),
		checkoutProducts: productKinds.map((productKind) => ({
			productKind,
			clicked: productEvents.filter(
				(e) => e.productKind === productKind && e.name === "purchase_clicked",
			).length,
			requested: productEvents.filter(
				(e) => e.productKind === productKind && e.name === "checkout_requested",
			).length,
			redirected: productEvents.filter(
				(e) => e.productKind === productKind && e.name === "checkout_redirected",
			).length,
			failed: productEvents.filter(
				(e) => e.productKind === productKind && e.name === "checkout_failed",
			).length,
		})),
	};
}
