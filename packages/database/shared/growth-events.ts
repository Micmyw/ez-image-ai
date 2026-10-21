import type { AdminAnalyticsQuery } from "./admin-analytics-reader";

export interface GrowthEventInput {
	id: string;
	sessionHash: string;
	userId: string | null;
	internal: boolean;
	name: string;
	path: string | null;
	source: string | null;
	medium: string | null;
	campaign: string | null;
	device: string;
	productKind: string | null;
	errorCategory: string | null;
	diagnostics?: Record<string, string | number | boolean> | null;
}

/** Run inside a transaction. Rate limits and idempotency are shared across Worker instances. */
export async function recordGrowthEventWithQuery(
	query: AdminAnalyticsQuery,
	event: GrowthEventInput,
) {
	const [limit] = await query<{ allowed: boolean }>(
		`
		INSERT INTO "rate_limit_bucket" (id, action, "subjectHash", "windowStart", "windowEnd", count, "updatedAt")
		VALUES (gen_random_uuid()::text, 'analytics:ingest', $1, date_trunc('minute', now()),
			date_trunc('minute', now()) + interval '1 minute', 1, now())
		ON CONFLICT (action, "subjectHash", "windowStart") DO UPDATE
		SET count = rate_limit_bucket.count + 1, "updatedAt" = now()
		RETURNING (count <= 90) AS allowed`,
		[event.sessionHash],
	);
	if (!limit?.allowed) return { accepted: false };
	// Bounded opportunistic retention. Idle sites purge on the next accepted observation.
	await query(
		`DELETE FROM growth_event WHERE id IN
		(SELECT id FROM growth_event WHERE "createdAt" < now() - interval '90 days' ORDER BY "createdAt" LIMIT 100)
		RETURNING id`,
		[],
	);
	await query(
		`INSERT INTO growth_event
		(id, "sessionHash", "userId", internal, name, path, source, medium, campaign, device, "productKind", "errorCategory", diagnostics)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
		[
			event.id,
			event.sessionHash,
			event.userId,
			event.internal,
			event.name,
			event.path,
			event.source,
			event.medium,
			event.campaign,
			event.device,
			event.productKind,
			event.errorCategory,
			event.diagnostics ? JSON.stringify(event.diagnostics) : null,
		],
	);
	return { accepted: true };
}
