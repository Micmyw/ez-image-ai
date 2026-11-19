import { db } from "../client";

const BATCH_SIZE = 1_000;

interface AnalyticsRetentionCounts {
	growthEvents: number;
	trafficCounters: number;
	rateLimitBuckets: number;
}

/** The scheduled cleanup can skip locked rows; later runs revisit them. */
export async function purgeExpiredAnalytics() {
	const [deleted] = await db.$queryRaw<AnalyticsRetentionCounts[]>`
		WITH growth AS (
			DELETE FROM growth_event WHERE id IN (
				SELECT id FROM growth_event WHERE "createdAt" < now() - interval '90 days'
				ORDER BY "createdAt" LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
			)
			RETURNING 1
		), traffic AS (
			DELETE FROM traffic_aggregate WHERE (hour, path, source, device) IN (
				SELECT hour, path, source, device FROM traffic_aggregate WHERE hour < now() - interval '90 days'
				ORDER BY hour, path, source, device LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
			)
			RETURNING 1
		), buckets AS (
			DELETE FROM rate_limit_bucket WHERE id IN (
				SELECT id FROM rate_limit_bucket
				WHERE action IN ('analytics:aggregate', 'analytics:ingest') AND "windowEnd" < now() - interval '1 day'
				ORDER BY "windowEnd" LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
			)
			RETURNING 1
		)
		SELECT (SELECT count(*)::int FROM growth) AS "growthEvents",
		       (SELECT count(*)::int FROM traffic) AS "trafficCounters",
		       (SELECT count(*)::int FROM buckets) AS "rateLimitBuckets"`;
	return deleted!;
}
