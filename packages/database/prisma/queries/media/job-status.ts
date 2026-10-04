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

export function getOwnedGenerationJobStatus(
	jobId: string,
	ownerId: string,
	client?: MediaDatabaseClient,
) {
	return getMediaDatabaseClient(client).generationJob.findFirst({
		where: { id: jobId, executionEngine: "legacy", ownerType: "USER", ownerId },
		select: MEDIA_JOB_STATUS_SELECT,
	});
}
