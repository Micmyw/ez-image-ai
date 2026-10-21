import { ADMIN_ANALYTICS_RANGES } from "./admin-analytics";
import type { AdminAnalyticsQuery } from "./admin-analytics-reader";
import type { ConversionInput } from "./conversion-funnel";

export interface AggregateTrafficInput {
	path: string;
	source: string;
	device: string;
}

/** No visit rows, identity, IP, session or raw user agent. Atomic hourly counters only. */
export async function recordAggregateTrafficWithQuery(
	query: AdminAnalyticsQuery,
	input: AggregateTrafficInput,
) {
	const [limit] = await query<{ allowed: boolean }>(
		`INSERT INTO rate_limit_bucket (id, action, "subjectHash", "windowStart", "windowEnd", count, "updatedAt")
	 VALUES (gen_random_uuid()::text, 'analytics:aggregate', 'global', date_trunc('minute', now()), date_trunc('minute', now()) + interval '1 minute', 1, now())
	 ON CONFLICT (action, "subjectHash", "windowStart") DO UPDATE SET count=rate_limit_bucket.count+1, "updatedAt"=now() RETURNING count <= 12000 AS allowed`,
		[],
	);
	if (!limit?.allowed) return { accepted: false };
	await query(
		`DELETE FROM traffic_aggregate WHERE (hour,path,source,device) IN (SELECT hour,path,source,device FROM traffic_aggregate WHERE hour < now()-interval '90 days' ORDER BY hour LIMIT 100) RETURNING hour`,
		[],
	);
	await query(
		`DELETE FROM rate_limit_bucket WHERE id IN (SELECT id FROM rate_limit_bucket WHERE action='analytics:aggregate' AND "windowEnd" < now()-interval '1 day' LIMIT 100) RETURNING id`,
		[],
	);
	await query(
		`INSERT INTO traffic_aggregate (hour,path,source,device,views) VALUES (date_trunc('hour',now()),$1,$2,$3,1)
	 ON CONFLICT (hour,path,source,device) DO UPDATE SET views=traffic_aggregate.views+1 RETURNING views`,
		[input.path, input.source, input.device],
	);
	return { accepted: true };
}

export function aggregateTrafficSince(input: ConversionInput) {
	const from = new Date((input.now ?? new Date()).getTime() - ADMIN_ANALYTICS_RANGES[input.range]);
	from.setUTCMinutes(0, 0, 0);
	return from;
}

export async function readAggregateTraffic(query: AdminAnalyticsQuery, input: ConversionInput) {
	const since = aggregateTrafficSince(input);
	// Anonymous sources are broad categories (for example google); detailed sources
	// can be exact hosts or campaign tags. Keep this summary independent of that filter.
	const rows = await query<{ source: string; views: number }>(
		`SELECT source, sum(views)::int AS views FROM traffic_aggregate WHERE hour >= $1 AND hour <= $2 AND ($3::text IS NULL OR device=$3) GROUP BY source ORDER BY sum(views) DESC, source`,
		[since, input.now ?? new Date(), input.device ?? null],
	);
	return {
		since: since.toISOString(),
		views: rows.reduce((total, row) => total + row.views, 0),
		sources: rows,
	};
}
