import { safeDiagnosticCode, safeDiagnosticText } from "./admin-content-diagnostics";
import type { MediaDatabaseClient } from "./types";

export type AdminContentOwner = {
	ownerType: "USER" | "ORGANIZATION" | "GUEST_BROWSER" | "UNKNOWN";
	ownerId: string;
};
export type AdminCustomerRecordKind = "INPUT" | "OUTPUT" | "JOB" | "BLOCKED_REQUEST";
interface CustomerFilter {
	limit: number;
	search?: string;
	audience?: "GUEST" | "ACCOUNT" | "UNKNOWN";
	before?: AdminContentOwner & { lastActivityAt: Date };
}
interface ContentFilter {
	owner: AdminContentOwner;
	limit: number;
	kind?: AdminCustomerRecordKind;
	issuesOnly?: boolean;
	before?: { createdAt: Date; recordKind: AdminCustomerRecordKind; id: string };
}
interface ContentRow extends AdminContentOwner {
	id: string;
	recordKind: AdminCustomerRecordKind;
	createdAt: Date;
	status: string;
	reasonCode: string | null;
	productKey: string | null;
	hasPrompt: boolean;
	isIssue: boolean;
}
interface CustomerRow extends AdminContentOwner {
	name: string | null;
	email: string | null;
	audience: "GUEST" | "ACCOUNT" | "UNKNOWN";
	lastActivityAt: Date;
	inputCount: number;
	outputCount: number;
	jobCount: number;
	blockedCount: number;
	issueCount: number;
}

// A signed browser is a grouping identity, not proof of one human. Historical
// upload buckets remain usable evidence while retained; new upload audits keep
// the association after those short-lived buckets disappear. Never join by IP,
// device fingerprint, content similarity or an uncompleted account handoff.
const entries = `WITH linked_guests AS (
	SELECT "anonymousOwnerId", min("registeredUserId") AS "registeredUserId"
	FROM guest_link_intent
	WHERE state = 'LINKED' AND "linkedAt" IS NOT NULL AND "registeredUserId" IS NOT NULL
	GROUP BY "anonymousOwnerId" HAVING count(DISTINCT "registeredUserId") = 1
), upload_browser_evidence AS (
	SELECT a.after->>'assetId' AS "assetId", a.metadata->>'browserSubjectHash' AS "browserHash"
	FROM audit_log a WHERE a.action = 'MEDIA_UPLOAD_SESSION_CREATED' AND a."targetType" = 'MEDIA_UPLOAD_SESSION'
		AND a.metadata->>'guestBrowserIdentityVersion' = '1' AND a.metadata->>'browserSubjectHash' ~ '^[a-f0-9]{64}$'
	UNION ALL
	SELECT s."assetId", substring(b.scope FROM 21)
	FROM media_upload_session s JOIN guest_abuse_bucket b ON b."subjectHash" = s.id
	WHERE b.scope ~ '^guest-upload-active:[a-f0-9]{64}$'
), upload_browsers AS (
	SELECT "assetId", min("browserHash") AS "browserHash" FROM upload_browser_evidence
	GROUP BY "assetId" HAVING count(DISTINCT "browserHash") = 1
), owner_browser_evidence AS (
	SELECT b."ownerId", u."browserHash" FROM guest_session_bootstrap b
	JOIN upload_browsers u ON u."assetId" = b."sourceAssetId" WHERE b."ownerId" IS NOT NULL
	UNION ALL
	SELECT a."ownerId", u."browserHash" FROM media_asset a JOIN upload_browsers u ON u."assetId" = a.id
	WHERE a."ownerType" = 'USER' AND a."retentionClass" = 'GUEST_TRIAL'
	UNION ALL
	SELECT substring(o."subjectKey" FROM 7), substring(b."subjectKey" FROM 9)
	FROM guest_trial_entitlement o JOIN guest_trial_entitlement b ON b."trialId" = o."trialId"
	WHERE starts_with(o."subjectKey", 'owner:') AND b."subjectKey" ~ '^browser:[a-f0-9]{64}$'
	UNION ALL
	SELECT a."actorUserId", COALESCE(CASE WHEN a.metadata->>'guestBrowserIdentityVersion' = '1'
		AND a.metadata->>'browserSubjectHash' ~ '^[a-f0-9]{64}$' THEN a.metadata->>'browserSubjectHash' END, u."browserHash")
	FROM audit_log a LEFT JOIN upload_browsers u ON u."assetId" = a.metadata->>'sourceAssetId'
	WHERE a.action = 'MEDIA_TEXT_MODERATION_BLOCKED' AND a."targetType" = 'GENERATION_QUOTE_REQUEST'
		AND a.metadata->>'audience' = 'GUEST' AND a."actorUserId" IS NOT NULL
), owner_browsers AS (
	SELECT "ownerId", min("browserHash") AS "browserHash" FROM owner_browser_evidence
	WHERE "browserHash" IS NOT NULL GROUP BY "ownerId" HAVING count(DISTINCT "browserHash") = 1
), raw_entries AS (
	SELECT a.id, a.kind::text AS "recordKind", a."createdAt", a."ownerType"::text AS "ownerType",
		CASE WHEN a."ownerType" = 'USER' AND a."retentionClass" = 'GUEST_TRIAL'
			AND starts_with(a."ownerId", 'guest_upload_') THEN COALESCE(b."ownerId", a."ownerId") ELSE a."ownerId" END AS "ownerId",
		a."ownerId" AS "originalOwnerId", a.status::text AS status,
		a."verificationLastErrorCode" AS "reasonCode", NULL::text AS "productKey",
		false AS "hasPrompt", a.status IN ('QUARANTINED', 'VERIFICATION_FAILED') AS "isIssue",
		a."retentionClass" = 'GUEST_TRIAL' AS "guestEvidence", COALESCE(ub."browserHash", ob."browserHash") AS "browserHash"
	FROM media_asset a LEFT JOIN guest_session_bootstrap b ON b."sourceAssetId" = a.id
	LEFT JOIN upload_browsers ub ON ub."assetId" = a.id
	LEFT JOIN owner_browsers ob ON a."ownerType" = 'USER' AND ob."ownerId" = a."ownerId"
	WHERE a."mimeType" LIKE 'image/%'
	UNION ALL
	SELECT j.id, 'JOB', j."createdAt", j."ownerType"::text, j."ownerId", j."ownerId", j.status::text,
		j."failureCode", j."productKey", COALESCE(length(btrim(j."inputSnapshot"->>'prompt')) > 0, false),
		j.status = 'FAILED' OR j."failureCode" IS NOT NULL,
		j."serviceClass" = 'GUEST_SLOW' OR j."guestTrialId" IS NOT NULL, ob."browserHash"
	FROM generation_job j LEFT JOIN owner_browsers ob ON j."ownerType" = 'USER' AND ob."ownerId" = j."ownerId"
	UNION ALL
	SELECT a.id, 'BLOCKED_REQUEST', a."createdAt",
		CASE WHEN a."actorUserId" IS NULL THEN 'UNKNOWN' ELSE 'USER' END,
		COALESCE(a."actorUserId", a.id), a."actorUserId", COALESCE(NULLIF(a.after->>'decision', ''), 'UNKNOWN'),
		a.after->>'reasonCode', a.metadata->>'productKey', COALESCE(length(btrim(a.metadata->>'prompt')) > 0, false),
		true, a.metadata->>'audience' = 'GUEST', COALESCE(CASE WHEN a.metadata->>'guestBrowserIdentityVersion' = '1'
			AND a.metadata->>'browserSubjectHash' ~ '^[a-f0-9]{64}$' THEN a.metadata->>'browserSubjectHash' END, ub."browserHash", ob."browserHash")
	FROM audit_log a LEFT JOIN upload_browsers ub ON ub."assetId" = a.metadata->>'sourceAssetId'
	LEFT JOIN owner_browsers ob ON ob."ownerId" = a."actorUserId"
	WHERE a.action = 'MEDIA_TEXT_MODERATION_BLOCKED' AND a."targetType" = 'GENERATION_QUOTE_REQUEST'
), resolved_entries AS (
	SELECT r.*, COALESCE(l."registeredUserId", r."ownerId") AS "accountId",
		r."ownerType" IN ('USER', 'UNKNOWN') AND (r."guestEvidence" OR u."isAnonymous" = true)
			AND u."isAnonymous" IS DISTINCT FROM false AND l."registeredUserId" IS NULL
			AND r."browserHash" IS NOT NULL AS "groupByBrowser"
	FROM raw_entries r LEFT JOIN linked_guests l ON r."ownerType" = 'USER' AND l."anonymousOwnerId" = r."ownerId"
	LEFT JOIN "user" u ON r."ownerType" = 'USER' AND u.id = r."ownerId"
), entries AS (
	SELECT r.*, CASE WHEN r."groupByBrowser" THEN 'GUEST_BROWSER' ELSE r."ownerType" END AS "customerType",
		CASE WHEN r."groupByBrowser" THEN 'browser_' || md5('admin-browser-v1:' || r."browserHash") ELSE r."accountId" END AS "customerId"
	FROM resolved_entries r
)`;

function queryParameters() {
	const parameters: unknown[] = [];
	return {
		parameters,
		parameter: (value: unknown) => {
			parameters.push(value);
			return `$${parameters.length}`;
		},
	};
}
const pageLimit = (limit: number) => Math.max(1, Math.min(50, Math.trunc(limit) || 25));

export function buildAdminCustomerListQuery(input: CustomerFilter) {
	const { parameters, parameter } = queryParameters();
	const conditions: string[] = [];
	if (input.search) {
		const exact = parameter(input.search);
		const text = parameter(`%${input.search.replace(/[\\%_]/g, "\\$&")}%`);
		conditions.push(`(c."ownerId" = ${exact} OR c.email ILIKE ${text} ESCAPE '\\'
			OR c.name ILIKE ${text} ESCAPE '\\' OR EXISTS (
				SELECT 1 FROM entries e WHERE e."customerType" = c."ownerType" AND e."customerId" = c."ownerId"
				AND (e.id = ${exact} OR e."originalOwnerId" = ${exact} OR e."ownerId" = ${exact})))`);
	}
	if (input.audience) conditions.push(`c.audience = ${parameter(input.audience)}`);
	if (input.before)
		conditions.push(
			`(c."lastActivityAt", c."ownerType", c."ownerId") < (${parameter(input.before.lastActivityAt)}, ${parameter(input.before.ownerType)}, ${parameter(input.before.ownerId)})`,
		);
	const limit = pageLimit(input.limit);
	return {
		parameters,
		limit,
		statement: `${entries}, grouped AS (
			SELECT "customerType" AS "ownerType", "customerId" AS "ownerId", max("createdAt") AS "lastActivityAt",
				count(*) FILTER (WHERE "recordKind" = 'INPUT')::int AS "inputCount",
				count(*) FILTER (WHERE "recordKind" = 'OUTPUT')::int AS "outputCount",
				count(*) FILTER (WHERE "recordKind" = 'JOB')::int AS "jobCount",
				count(*) FILTER (WHERE "recordKind" = 'BLOCKED_REQUEST')::int AS "blockedCount",
				count(*) FILTER (WHERE "isIssue")::int AS "issueCount", bool_or("guestEvidence") AS guest
			FROM entries GROUP BY "customerType", "customerId"
		), customers AS (
			SELECT g."ownerType", g."ownerId", g."lastActivityAt", g."inputCount", g."outputCount", g."jobCount", g."blockedCount", g."issueCount",
				COALESCE(u.name, o.name) AS name, u.email,
				CASE WHEN g."ownerType" = 'GUEST_BROWSER' OR u."isAnonymous" = true THEN 'GUEST'
					WHEN u.id IS NOT NULL OR o.id IS NOT NULL THEN 'ACCOUNT'
					WHEN g.guest THEN 'GUEST' ELSE 'UNKNOWN' END AS audience
			FROM grouped g LEFT JOIN "user" u ON g."ownerType" = 'USER' AND u.id = g."ownerId"
			LEFT JOIN organization o ON g."ownerType" = 'ORGANIZATION' AND o.id = g."ownerId"
		) SELECT c.* FROM customers c ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
		ORDER BY c."lastActivityAt" DESC, c."ownerType" DESC, c."ownerId" DESC LIMIT ${parameter(limit + 1)}`,
	};
}

export function buildAdminCustomerContentQuery(input: ContentFilter) {
	const { parameters, parameter } = queryParameters();
	const conditions = [
		`e."customerType" = ${parameter(input.owner.ownerType)}`,
		`e."customerId" = ${parameter(input.owner.ownerId)}`,
	];
	if (input.kind) conditions.push(`e."recordKind" = ${parameter(input.kind)}`);
	if (input.issuesOnly) conditions.push(`e."isIssue" = true`);
	if (input.before)
		conditions.push(
			`(e."createdAt", e."recordKind", e.id) < (${parameter(input.before.createdAt)}, ${parameter(input.before.recordKind)}, ${parameter(input.before.id)})`,
		);
	const limit = pageLimit(input.limit);
	return {
		parameters,
		limit,
		statement: `${entries} SELECT e.id, e."recordKind", e."createdAt", e."customerType" AS "ownerType", e."customerId" AS "ownerId",
			e.status, e."reasonCode", e."productKey", e."hasPrompt", e."isIssue"
		FROM entries e WHERE ${conditions.join(" AND ")}
		ORDER BY e."createdAt" DESC, e."recordKind" DESC, e.id DESC LIMIT ${parameter(limit + 1)}`,
	};
}

export async function listAdminContentCustomers(
	input: CustomerFilter,
	actorUserId: string,
	client: MediaDatabaseClient,
) {
	const query = buildAdminCustomerListQuery(input);
	const rows = await client.$queryRawUnsafe<CustomerRow[]>(query.statement, ...query.parameters);
	const items = rows.slice(0, query.limit);
	await client.auditLog.create({
		data: {
			actorUserId,
			action: "MEDIA_CONTENT_CUSTOMERS_LISTED",
			targetType: "ADMIN_MEDIA_CONTENT",
			targetId: "customers",
			metadata: {
				resultCount: items.length,
				searchFilter: Boolean(input.search),
				audience: input.audience ?? "ALL",
			},
		},
	});
	const last = items.at(-1);
	return {
		items,
		nextCursor:
			rows.length > query.limit && last
				? { ownerType: last.ownerType, ownerId: last.ownerId, lastActivityAt: last.lastActivityAt }
				: null,
	};
}

export async function listAdminCustomerContent(
	input: ContentFilter,
	actorUserId: string,
	client: MediaDatabaseClient,
) {
	const query = buildAdminCustomerContentQuery(input);
	const rows = await client.$queryRawUnsafe<ContentRow[]>(query.statement, ...query.parameters);
	const page = rows.slice(0, query.limit);
	await client.auditLog.create({
		data: {
			actorUserId,
			action: "MEDIA_CUSTOMER_TIMELINE_VIEWED",
			targetType: "ADMIN_MEDIA_CONTENT",
			targetId: input.owner.ownerId,
			metadata: {
				ownerType: input.owner.ownerType,
				resultCount: page.length,
				kind: input.kind ?? "ALL",
				issuesOnly: input.issuesOnly ?? false,
			},
		},
	});
	const last = page.at(-1);
	return {
		items: page.map((row) => ({
			...row,
			status: safeDiagnosticCode(row.status, 80) ?? "UNKNOWN",
			reasonCode: safeDiagnosticCode(row.reasonCode, 160),
			productKey: safeDiagnosticText(row.productKey, 160),
		})),
		nextCursor:
			rows.length > query.limit && last
				? { createdAt: last.createdAt, recordKind: last.recordKind, id: last.id }
				: null,
	};
}
