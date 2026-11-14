import type { Prisma } from "../../generated/client";
import {
	attemptProjection,
	diagnosticObject,
	promptReviewProjection,
	safeDiagnosticCode,
	safeDiagnosticIdentifier,
	safeDiagnosticText,
} from "./admin-content-diagnostics";
import type { MediaDatabaseClient } from "./types";

export type AdminPromptRecordKind = "JOB" | "BLOCKED_REQUEST";
export type AdminPromptAudience = "GUEST" | "ACCOUNT" | "UNKNOWN";
export interface AdminPromptContentFilter {
	limit: number;
	from?: Date;
	to?: Date;
	recordKind?: AdminPromptRecordKind;
	audience?: AdminPromptAudience;
	outcome?: "ALL" | "FAILURES";
	ownerId?: string;
	email?: string;
	jobId?: string;
	text?: string;
	before?: { createdAt: Date; id: string; recordKind: AdminPromptRecordKind };
}
type AudienceBasis = "JOB_RECORD" | "RECORDED" | "CURRENT_ACCOUNT" | "UNKNOWN";
interface ListRow {
	id: string;
	recordKind: AdminPromptRecordKind;
	createdAt: Date;
	ownerType: "USER" | "ORGANIZATION" | null;
	ownerId: string | null;
	submittedByUserId: string | null;
	accountEmail: string | null;
	audience: AdminPromptAudience;
	audienceBasis: AudienceBasis;
	jobId: string | null;
	productKey: string | null;
	status: string;
	failureCode: string | null;
	hasPrompt: boolean;
}

const MAX_WINDOW_MS = 90 * 24 * 60 * 60_000;
function range(input: AdminPromptContentFilter) {
	const to = input.to ?? new Date();
	const from = input.from ?? new Date(to.getTime() - 7 * 24 * 60 * 60_000);
	if (
		!Number.isFinite(from.getTime()) ||
		!Number.isFinite(to.getTime()) ||
		from >= to ||
		to.getTime() - from.getTime() > MAX_WINDOW_MS
	)
		throw new Error("ADMIN_PROMPT_RANGE_INVALID");
	return { from, to };
}

/** Parameterized, bounded union: neither branch needs an asset or a moderation recovery row. */
export function buildAdminPromptContentQuery(input: AdminPromptContentFilter) {
	const { from, to } = range(input);
	const parameters: unknown[] = [from, to];
	const parameter = (value: unknown) => {
		parameters.push(value);
		return `$${parameters.length}`;
	};
	const where: string[] = [];
	if (input.recordKind) where.push(`e."recordKind" = ${parameter(input.recordKind)}`);
	if (input.audience) where.push(`e.audience = ${parameter(input.audience)}`);
	if ((input.outcome ?? "FAILURES") === "FAILURES")
		where.push(
			`(e."recordKind" = 'BLOCKED_REQUEST' OR e.status = 'FAILED' OR e."failureCode" IS NOT NULL)`,
		);
	if (input.ownerId) where.push(`e."ownerId" = ${parameter(input.ownerId)}`);
	if (input.email) where.push(`lower(e."accountEmail") = lower(${parameter(input.email)})`);
	if (input.jobId) where.push(`e."jobId" = ${parameter(input.jobId)}`);
	if (input.text)
		where.push(
			`e.prompt ILIKE ${parameter(`%${input.text.replace(/[\\%_]/g, "\\$&")}%`)} ESCAPE '\\'`,
		);
	if (input.before) {
		const at = parameter(input.before.createdAt);
		const key = parameter(`${input.before.recordKind}:${input.before.id}`);
		where.push(`(e."createdAt" < ${at} OR (e."createdAt" = ${at} AND e."sortKey" < ${key}))`);
	}
	const limit = Math.max(1, Math.min(50, Math.trunc(input.limit) || 25));
	const take = parameter(limit + 1);
	return {
		parameters,
		limit,
		from,
		to,
		statement: `WITH entries AS (
		SELECT j.id, 'JOB'::text AS "recordKind", ('JOB:' || j.id) AS "sortKey", j."createdAt",
			j."ownerType"::text AS "ownerType", j."ownerId", j."submittedByUserId", u.email AS "accountEmail",
			CASE WHEN j."serviceClass"::text = 'GUEST_SLOW' OR j."guestTrialId" IS NOT NULL THEN 'GUEST' ELSE 'ACCOUNT' END AS audience,
			'JOB_RECORD'::text AS "audienceBasis", j.id AS "jobId", j."productKey", j.status::text AS status, j."failureCode",
			CASE WHEN jsonb_typeof(j."inputSnapshot"->'prompt') = 'string' THEN j."inputSnapshot"->>'prompt' ELSE NULL END AS prompt
		FROM generation_job j LEFT JOIN "user" u ON u.id = j."submittedByUserId"
		WHERE j."createdAt" >= $1 AND j."createdAt" < $2
		UNION ALL
		SELECT a.id, 'BLOCKED_REQUEST'::text, ('BLOCKED_REQUEST:' || a.id), a."createdAt", 'USER'::text, a."actorUserId", a."actorUserId", u.email,
			CASE WHEN a.metadata->>'audience' IN ('GUEST','ACCOUNT') THEN a.metadata->>'audience'
				WHEN u."isAnonymous" = true THEN 'GUEST' WHEN u."isAnonymous" = false THEN 'ACCOUNT' ELSE 'UNKNOWN' END,
			CASE WHEN a.metadata->>'audience' IN ('GUEST','ACCOUNT') THEN 'RECORDED' WHEN u.id IS NOT NULL THEN 'CURRENT_ACCOUNT' ELSE 'UNKNOWN' END,
			NULL::text, a.metadata->>'productKey', COALESCE(NULLIF(a.after->>'decision',''), 'UNKNOWN'), a.after->>'reasonCode',
			CASE WHEN jsonb_typeof(a.metadata->'prompt') = 'string' THEN a.metadata->>'prompt' ELSE NULL END
		FROM audit_log a LEFT JOIN "user" u ON u.id = a."actorUserId"
		WHERE a.action = 'MEDIA_TEXT_MODERATION_BLOCKED' AND a."targetType" = 'GENERATION_QUOTE_REQUEST'
			AND a."createdAt" >= $1 AND a."createdAt" < $2
	) SELECT e.id, e."recordKind", e."createdAt", e."ownerType", e."ownerId", e."submittedByUserId", e."accountEmail",
		e.audience, e."audienceBasis", e."jobId", e."productKey", e.status, e."failureCode",
		COALESCE(length(btrim(e.prompt)) > 0, false) AS "hasPrompt"
	FROM entries e ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
	ORDER BY e."createdAt" DESC, e."sortKey" DESC LIMIT ${take}`,
	};
}

export async function listAdminPromptContent(
	input: AdminPromptContentFilter,
	actorUserId: string,
	client: MediaDatabaseClient,
) {
	const query = buildAdminPromptContentQuery(input);
	const rows = await client.$queryRawUnsafe<ListRow[]>(query.statement, ...query.parameters);
	const page = rows.slice(0, query.limit);
	await client.auditLog.create({
		data: {
			actorUserId,
			action: "MEDIA_CUSTOMER_PROMPTS_LISTED",
			targetType: "ADMIN_MEDIA_CONTENT",
			targetId: "prompts",
			metadata: {
				recordKind: input.recordKind ?? "ALL",
				audience: input.audience ?? "ALL",
				outcome: input.outcome ?? "FAILURES",
				from: query.from.toISOString(),
				to: query.to.toISOString(),
				resultCount: page.length,
				ownerFilter: Boolean(input.ownerId),
				emailFilter: Boolean(input.email),
				jobFilter: Boolean(input.jobId),
				textFilter: Boolean(input.text),
			},
		},
	});
	const last = page.at(-1);
	return {
		items: page.map((row) => ({
			...row,
			productKey: safeDiagnosticText(row.productKey, 160),
			status: safeDiagnosticCode(row.status, 80) ?? "UNKNOWN",
			failureCode: safeDiagnosticCode(row.failureCode, 160),
		})),
		nextCursor:
			rows.length > query.limit && last
				? { createdAt: last.createdAt, recordKind: last.recordKind, id: last.id }
				: null,
		from: query.from,
		to: query.to,
	};
}

const jobSelect = {
	id: true,
	ownerType: true,
	ownerId: true,
	submittedByUserId: true,
	productKey: true,
	status: true,
	failureCode: true,
	failureMessage: true,
	inputSnapshot: true,
	quoteId: true,
	createdAt: true,
	serviceClass: true,
	guestTrialId: true,
	attempts: {
		orderBy: { attemptNumber: "desc" },
		take: 10,
		select: {
			id: true,
			provider: true,
			providerTaskId: true,
			status: true,
			uncertainSubmission: true,
			responseSnapshot: true,
			errorSnapshot: true,
			createdAt: true,
		},
	},
} satisfies Prisma.GenerationJobSelect;

function blockedAudience(
	metadata: Record<string, unknown>,
	user: { isAnonymous: boolean | null } | null,
): { audience: AdminPromptAudience; audienceBasis: AudienceBasis } {
	if (metadata.audience === "GUEST" || metadata.audience === "ACCOUNT")
		return { audience: metadata.audience, audienceBasis: "RECORDED" };
	if (user?.isAnonymous === true) return { audience: "GUEST", audienceBasis: "CURRENT_ACCOUNT" };
	if (user?.isAnonymous === false) return { audience: "ACCOUNT", audienceBasis: "CURRENT_ACCOUNT" };
	return { audience: "UNKNOWN", audienceBasis: "UNKNOWN" };
}

function promptEvidence(row: { id: string; after: unknown; createdAt: Date }) {
	const data = diagnosticObject(row.after);
	const evidence = diagnosticObject(data.evidence);
	const waffo = diagnosticObject(evidence.waffo);
	return {
		...promptReviewProjection(row.after, row.createdAt, row.id),
		ruleVersion: safeDiagnosticText(data.ruleVersion, 160),
		requestId:
			safeDiagnosticIdentifier(evidence.requestId) ?? safeDiagnosticIdentifier(waffo.requestId),
		evidenceSource: "PERSISTED_AUDIT" as const,
	};
}

/** Audited administrator detail; no live provider requests, signing, mutation of jobs or invented messages. */
export async function getAdminPromptContent(
	input: { recordKind: AdminPromptRecordKind; id: string },
	actorUserId: string,
	client: MediaDatabaseClient,
) {
	const [job, blocked] = await Promise.all([
		input.recordKind === "JOB"
			? client.generationJob.findUnique({ where: { id: input.id }, select: jobSelect })
			: null,
		input.recordKind === "BLOCKED_REQUEST"
			? client.auditLog.findFirst({
					where: {
						id: input.id,
						action: "MEDIA_TEXT_MODERATION_BLOCKED",
						targetType: "GENERATION_QUOTE_REQUEST",
					},
					select: { id: true, actorUserId: true, metadata: true, after: true, createdAt: true },
				})
			: null,
	]);
	if (!job && !blocked) throw new Error("ADMIN_PROMPT_CONTENT_NOT_FOUND");
	const userId = job?.submittedByUserId ?? blocked?.actorUserId ?? null;
	const user = userId
		? await client.user.findUnique({
				where: { id: userId },
				select: { email: true, isAnonymous: true },
			})
		: null;
	const metadata = diagnosticObject(blocked?.metadata);
	const rawPrompt = diagnosticObject(job?.inputSnapshot).prompt ?? metadata.prompt;
	const audits = job
		? await client.auditLog.findMany({
				where: {
					action: "MEDIA_TEXT_MODERATION_ALLOWED",
					targetType: "GENERATION_QUOTE",
					targetId: job.quoteId,
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 20,
				select: { id: true, after: true, createdAt: true },
			})
		: blocked
			? [blocked]
			: [];
	await client.auditLog.create({
		data: {
			actorUserId,
			action: "MEDIA_CUSTOMER_PROMPT_VIEWED",
			targetType: job ? "GENERATION_JOB" : "AUDIT_LOG",
			targetId: input.id,
			metadata: { recordKind: input.recordKind },
		},
	});
	return {
		id: input.id,
		recordKind: input.recordKind,
		createdAt: (job ?? blocked)!.createdAt,
		ownerType: job?.ownerType ?? ("USER" as const),
		ownerId: job?.ownerId ?? blocked?.actorUserId ?? null,
		submittedByUserId: userId,
		accountEmail: user?.email ?? null,
		...(job
			? {
					audience:
						job.serviceClass === "GUEST_SLOW" || job.guestTrialId
							? ("GUEST" as const)
							: ("ACCOUNT" as const),
					audienceBasis: "JOB_RECORD" as const,
				}
			: blockedAudience(metadata, user)),
		jobId: job?.id ?? null,
		productKey: safeDiagnosticText(job?.productKey ?? metadata.productKey, 160),
		status:
			safeDiagnosticCode(job?.status ?? diagnosticObject(blocked?.after).decision, 80) ?? "UNKNOWN",
		failureCode: safeDiagnosticCode(
			job?.failureCode ?? diagnosticObject(blocked?.after).reasonCode,
			160,
		),
		failureMessage: safeDiagnosticText(job?.failureMessage),
		prompt: safeDiagnosticText(rawPrompt, 10_000),
		promptTruncated: typeof rawPrompt === "string" && rawPrompt.length > 10_000,
		promptSource: job ? ("JOB_INPUT_SNAPSHOT" as const) : ("BLOCKED_AUDIT_METADATA" as const),
		promptReviews: audits
			.filter((row) => Object.keys(diagnosticObject(row.after)).length > 0)
			.map(promptEvidence),
		attempts: (job?.attempts ?? []).map(attemptProjection),
	};
}
