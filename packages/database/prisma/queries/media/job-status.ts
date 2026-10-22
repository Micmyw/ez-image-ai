import type { Prisma } from "../../generated/client";
import { getMediaDatabaseClient, type MediaDatabaseClient } from "./types";

// No provider envelopes, pricing graph, transfer/session state, reservation ledger,
// or historical attempts. Evidence fields are needed to authorize the inline URL.
export const MEDIA_JOB_STATUS_SELECT = {
	id: true,
	status: true,
	version: true,
	productKey: true,
	inputSnapshot: true,
	creditsReserved: true,
	fundingSource: true,
	imagePassReservation: { select: { status: true } },
	archivedCreditsCharged: true,
	archivedCreditsReleased: true,
	failureCode: true,
	createdAt: true,
	updatedAt: true,
	reservation: { select: { status: true, settledAmount: true, releasedAmount: true } },
	_count: {
		select: {
			attempts: {
				where: {
					OR: [
						{ uncertainSubmission: true },
						{ status: { in: ["SUBMISSION_UNCERTAIN", "NEEDS_RECONCILIATION"] } },
					],
				},
			},
		},
	},
	attempts: {
		orderBy: { attemptNumber: "desc" },
		take: 1,
		select: { id: true, progress: true, status: true, uncertainSubmission: true },
	},
	assets: {
		orderBy: [{ role: "asc" }, { position: "asc" }, { id: "asc" }],
		select: {
			role: true,
			position: true,
			asset: {
				select: {
					id: true,
					ownerType: true,
					ownerId: true,
					kind: true,
					status: true,
					deletedAt: true,
					deleteAfter: true,
					objectKey: true,
					checksum: true,
					mimeType: true,
					byteSize: true,
					width: true,
					height: true,
					durationMillis: true,
					createdAt: true,
					updatedAt: true,
					verificationGeneration: true,
					verificationAttemptCount: true,
					verificationProvider: true,
					verificationProviderTaskId: true,
					verificationRuleVersion: true,
					verificationPolicyVersion: true,
					verificationValidUntil: true,
					moderationResults: {
						orderBy: [
							{ verificationGeneration: "desc" },
							{ attemptNumber: "desc" },
							{ createdAt: "desc" },
							{ id: "desc" },
						],
						take: 1,
						select: {
							id: true,
							status: true,
							reasonCode: true,
							assetChecksum: true,
							verificationGeneration: true,
							attemptNumber: true,
							evidenceKind: true,
							provider: true,
							providerTaskId: true,
							ruleVersion: true,
							policyVersion: true,
							validUntil: true,
							createdAt: true,
						},
					},
				},
			},
		},
	},
} satisfies Prisma.GenerationJobSelect;

type JobStatus = Prisma.GenerationJobGetPayload<{ select: typeof MEDIA_JOB_STATUS_SELECT }>;
type JsonProjection<T> = T extends Date | bigint
	? string
	: T extends Array<infer Item>
		? Array<JsonProjection<Item>>
		: T extends object
			? { [Key in keyof T]: JsonProjection<T[Key]> }
			: T;
type JobStatusRow = Omit<JobStatus, "reservation" | "assets"> & {
	reservation: JsonProjection<JobStatus["reservation"]>;
	assets: JsonProjection<JobStatus["assets"]>;
};

export async function getOwnedGenerationJobStatus(
	jobId: string,
	ownerId: string,
	client?: MediaDatabaseClient,
): Promise<JobStatus | null> {
	// A single statement gives all authorization and funding fields one fresh
	// snapshot, without Prisma's separate relation round trips. Optional one-to-one
	// joins and the lateral asset aggregate cannot multiply a job's bindings.
	const [row] = await getMediaDatabaseClient(client).$queryRaw<JobStatusRow[]>`
		SELECT job."id", job."status", job."version", job."productKey", job."inputSnapshot",
			job."creditsReserved", job."fundingSource", job."archivedCreditsCharged",
			job."archivedCreditsReleased", job."failureCode", job."createdAt", job."updatedAt",
			CASE WHEN pass."id" IS NULL THEN NULL ELSE
				jsonb_build_object('status', pass."status") END AS "imagePassReservation",
			CASE WHEN credit."id" IS NULL THEN NULL ELSE jsonb_build_object(
				'status', credit."status", 'settledAmount', credit."settledAmount"::text,
				'releasedAmount', credit."releasedAmount"::text) END AS "reservation",
			jsonb_build_object('attempts', (
				SELECT count(*)::integer FROM "generation_attempt" unresolved
				WHERE unresolved."jobId" = job."id" AND (unresolved."uncertainSubmission"
					OR unresolved."status" IN ('SUBMISSION_UNCERTAIN', 'NEEDS_RECONCILIATION'))
			)) AS "_count",
			CASE WHEN latest."id" IS NULL THEN '[]'::jsonb ELSE
				jsonb_build_array(to_jsonb(latest)) END AS "attempts",
			COALESCE(bindings."assets", '[]'::jsonb) AS "assets"
		FROM "generation_job" job
		LEFT JOIN "credit_reservation" credit ON credit."jobId" = job."id"
		LEFT JOIN "image_pass_reservation" pass ON pass."jobId" = job."id"
		LEFT JOIN LATERAL (
			SELECT attempt."id", attempt."progress", attempt."status", attempt."uncertainSubmission"
			FROM "generation_attempt" attempt WHERE attempt."jobId" = job."id"
			ORDER BY attempt."attemptNumber" DESC LIMIT 1
		) latest ON TRUE
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(jsonb_build_object(
				'role', binding."role", 'position', binding."position", 'asset', jsonb_build_object(
					'id', asset."id", 'ownerType', asset."ownerType", 'ownerId', asset."ownerId",
					'kind', asset."kind", 'status', asset."status", 'deletedAt', asset."deletedAt",
					'deleteAfter', asset."deleteAfter", 'objectKey', asset."objectKey", 'checksum', asset."checksum",
					'mimeType', asset."mimeType", 'byteSize', asset."byteSize"::text,
					'width', asset."width", 'height', asset."height", 'durationMillis', asset."durationMillis"::text,
					'createdAt', asset."createdAt", 'updatedAt', asset."updatedAt",
					'verificationGeneration', asset."verificationGeneration",
					'verificationAttemptCount', asset."verificationAttemptCount",
					'verificationProvider', asset."verificationProvider",
					'verificationProviderTaskId', asset."verificationProviderTaskId",
					'verificationRuleVersion', asset."verificationRuleVersion",
					'verificationPolicyVersion', asset."verificationPolicyVersion",
					'verificationValidUntil', asset."verificationValidUntil",
					'moderationResults', CASE WHEN evidence."id" IS NULL THEN '[]'::jsonb ELSE
						jsonb_build_array(to_jsonb(evidence)) END
				)
			) ORDER BY binding."role", binding."position", binding."id") AS "assets"
			FROM "generation_job_asset" binding
			JOIN "media_asset" asset ON asset."id" = binding."assetId"
			LEFT JOIN LATERAL (
				SELECT result."id", result."status", result."reasonCode", result."assetChecksum",
					result."verificationGeneration", result."attemptNumber", result."evidenceKind",
					result."provider", result."providerTaskId", result."ruleVersion", result."policyVersion",
					result."validUntil", result."createdAt"
				FROM "asset_moderation_result" result WHERE result."assetId" = asset."id"
				ORDER BY result."verificationGeneration" DESC, result."attemptNumber" DESC,
					result."createdAt" DESC, result."id" DESC LIMIT 1
			) evidence ON TRUE
			WHERE binding."jobId" = job."id"
		) bindings ON TRUE
		WHERE job."id" = ${jobId} AND job."executionEngine" = 'legacy'
			AND job."ownerType" = 'USER' AND job."ownerId" = ${ownerId}
	`;
	if (!row) return null;
	// Only relation JSON needs hydration. Cast its bigint values to text in SQL
	// before JSON parsing, which otherwise loses precision above 2^53. Scalar job
	// dates and bigints already use Prisma's native raw-query deserialization.
	return {
		...row,
		reservation: row.reservation && {
			...row.reservation,
			settledAmount: BigInt(row.reservation.settledAmount),
			releasedAmount: BigInt(row.reservation.releasedAmount),
		},
		assets: row.assets.map(({ asset, ...binding }) => ({
			...binding,
			asset: {
				...asset,
				byteSize: BigInt(asset.byteSize),
				durationMillis: asset.durationMillis === null ? null : BigInt(asset.durationMillis),
				createdAt: new Date(asset.createdAt),
				updatedAt: new Date(asset.updatedAt),
				deletedAt: asset.deletedAt === null ? null : new Date(asset.deletedAt),
				deleteAfter: asset.deleteAfter === null ? null : new Date(asset.deleteAfter),
				verificationValidUntil:
					asset.verificationValidUntil === null ? null : new Date(asset.verificationValidUntil),
				moderationResults: asset.moderationResults.map((evidence) => ({
					...evidence,
					createdAt: new Date(evidence.createdAt),
					validUntil: evidence.validUntil === null ? null : new Date(evidence.validUntil),
				})),
			},
		})),
	};
}
