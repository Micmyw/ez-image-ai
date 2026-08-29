import type { Prisma } from "../../generated/client";
import { hasCurrentApprovedMediaAssetEvidence } from "./assets";
import { createCreditGrant, reserveCreditsInTransaction } from "./credits";
import { consumeGuestTurnstileTokenHash, incrementGuestBucket } from "./guest-bootstrap";
import { deriveGuestQueueEstimate } from "./guest-retention";
import {
	createModeratedGenerationQuote,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";
import { ACTIVE_GENERATION_JOB_STATUSES } from "./state-machine";
import type { CreateModeratedGenerationQuoteInput, MediaTransactionClient } from "./types";
import { isDatabaseUniqueConflict, runReadCommitted } from "./types";

export const GUEST_GENERATION_ELIGIBLE_EVENT = "GUEST_GENERATION_ELIGIBLE";

export type GuestJobStage =
	| "WAITING"
	| "EDITING"
	| "FINISHING"
	| "READY"
	| "REJECTED"
	| "FAILED"
	| "EXPIRED";

export interface GuestJobSnapshot {
	jobId: string;
	stage: GuestJobStage;
	projectedDispatchAt: Date;
	estimateExpiresAt: Date;
	resultExpiresAt: Date;
	resultAssetId: string | null;
	watermarked: boolean;
	trialConsumed: boolean;
	linkReady: boolean;
}

export interface CreateGuestGenerationTransactionInput {
	ownerId: string;
	promotionPeriod: string;
	capabilityVersion: string;
	sourceSessionHash: string;
	deviceHash: string;
	ipHash: string;
	subnetHash: string;
	idempotencyKey: string;
	idempotencyFingerprint: string;
	turnstile: {
		tokenHash: string;
		challengeTimestamp: Date;
		expiresAt: Date;
	};
	sourceDraftId: string;
	sourceBootstrapId: string;
	sourceAssetId: string;
	sourceAssetChecksum: string;
	now: Date;
	retentionMs: number;
	queueTtlMs: number;
	serviceTimeMs: number;
	queueCapacity?: number;
	maximumBytes: number;
	maximumGlobalQueueDepth: number;
	maximumActiveJobsPerGuest: number;
	maximumRequestsPerMinute: number;
	maximumRequestsPerIpPerHour: number;
	maximumAcceptedTrialsPerSession?: number;
	maximumActiveJobsPerDevice?: number;
	maximumAcceptedTrialsPerDevicePromotion?: number;
	maximumActiveJobsPerIp?: number;
	maximumRequestsPerIpPerTenMinutes?: number;
	maximumRequestsPerIpPerDay?: number;
	maximumRequestsPerSubnetPerDay?: number;
	maximumGlobalRequestsPerMinute?: number;
	maximumGlobalRequestsPerHour?: number;
	maximumGlobalRequestsPerDay?: number;
	abuseEvidenceTtlMs: number;
	riskBudgetMicros: bigint;
	sponsorCredits: bigint;
	assetModeration: {
		provider: string;
		ruleVersion: string;
		policyVersion: string;
	};
	quote: CreateModeratedGenerationQuoteInput;
}

export interface CreateGuestGenerationTransactionResult extends GuestJobSnapshot {
	trialId: string;
}

export interface CanonicalGuestGenerationQuote {
	productKey: string;
	catalogVersion: string;
	pricingVersion: string;
	credits: bigint;
	costMicros: bigint;
	pricingSnapshot: Prisma.InputJsonValue;
}

export type ResolveCanonicalGuestGenerationQuote = (input: {
	productKey: "image-fast";
	inputSnapshot: Prisma.InputJsonValue;
}) => CanonicalGuestGenerationQuote | Promise<CanonicalGuestGenerationQuote>;

export interface GuestGrantedAsset {
	id: string;
	objectKey: string;
	verificationValidUntil: Date;
	deleteAfter: Date;
	resultExpiresAt: Date;
}

export type GuestAdmissionDenialReason =
	| "CAPABILITY"
	| "CONTENT"
	| "DEVICE_LIMIT"
	| "GLOBAL_RATE_LIMIT"
	| "INPUT"
	| "IP_RATE_LIMIT"
	| "OWNER_CAPACITY"
	| "QUEUE_CAPACITY"
	| "QUOTE"
	| "RISK_CAPACITY"
	| "SUBNET_RATE_LIMIT"
	| "TRIAL_UNAVAILABLE"
	| "TURNSTILE"
	| "TURNSTILE_REPLAY";

export interface RecordGuestAdmissionDenialInput {
	promotionPeriod: string;
	reason: GuestAdmissionDenialReason;
	subjectHash: string;
	now: Date;
	evidenceTtlMs?: number;
}

export async function recordGuestAdmissionDenial(
	input: RecordGuestAdmissionDenialInput,
	client: MediaTransactionClient,
): Promise<void> {
	if (
		!input.promotionPeriod ||
		!/^[A-Z][A-Z0-9_]{0,127}$/.test(input.reason) ||
		!/^[a-f0-9]{64}$/.test(input.subjectHash) ||
		Number.isNaN(input.now.getTime())
	) {
		throw new Error("GUEST_DENIAL_INPUT_INVALID");
	}
	const windowStart = new Date(0);
	const windowEnd = new Date(1);
	const evidenceTtlMs = input.evidenceTtlMs ?? 90 * 24 * 60 * 60_000;
	if (!Number.isSafeInteger(evidenceTtlMs) || evidenceTtlMs <= 0) {
		throw new Error("GUEST_DENIAL_INPUT_INVALID");
	}
	const expiresAt = new Date(input.now.getTime() + evidenceTtlMs);
	await client.guestAbuseBucket.upsert({
		where: {
			scope_subjectHash_windowStart: {
				scope: `guest-denial:${input.promotionPeriod}:${input.reason}`,
				subjectHash: input.subjectHash,
				windowStart,
			},
		},
		create: {
			scope: `guest-denial:${input.promotionPeriod}:${input.reason}`,
			subjectHash: input.subjectHash,
			windowStart,
			windowEnd,
			rejectionCount: 1n,
			expiresAt,
		},
		update: { expiresAt },
	});
}

export async function createGuestGenerationTransaction(
	input: CreateGuestGenerationTransactionInput,
	client: MediaTransactionClient,
	resolveCanonicalQuote: ResolveCanonicalGuestGenerationQuote,
): Promise<CreateGuestGenerationTransactionResult> {
	validateAdmissionInput(input);
	try {
		return await runReadCommitted(client, async (tx) => {
			await acquireGuestAdmissionLocks(input, tx);
			const replay = await findGuestAdmissionReplay(input, tx);
			if (replay) return replay;
			if (!(await consumeGuestTurnstileTokenHash(input.turnstile, tx))) {
				throw new Error("TURNSTILE_REPLAYED");
			}

			const linkIntent = await tx.guestLinkIntent.findUnique({
				where: {
					anonymousOwnerId_promotionPeriod: {
						anonymousOwnerId: input.ownerId,
						promotionPeriod: input.promotionPeriod,
					},
				},
				select: { state: true },
			});
			if (linkIntent) throw new Error("GUEST_LINK_IN_PROGRESS");

			const existingTrial = await tx.guestMediaTrial.findUnique({
				where: {
					ownerId_promotionPeriod: {
						ownerId: input.ownerId,
						promotionPeriod: input.promotionPeriod,
					},
				},
				select: { id: true },
			});
			if (existingTrial) throw new Error("GUEST_TRIAL_UNAVAILABLE");
			const [sessionTrialCount, deviceTrialCount] = await Promise.all([
				tx.guestMediaTrial.count({
					where: {
						promotionPeriod: input.promotionPeriod,
						sourceSessionHash: input.sourceSessionHash,
					},
				}),
				tx.guestMediaTrial.count({
					where: { promotionPeriod: input.promotionPeriod, deviceHash: input.deviceHash },
				}),
			]);
			if (
				sessionTrialCount >= (input.maximumAcceptedTrialsPerSession ?? 1) ||
				deviceTrialCount >= (input.maximumAcceptedTrialsPerDevicePromotion ?? 1)
			) {
				throw new Error("GUEST_TRIAL_UNAVAILABLE");
			}

			await assertAnonymousOwner(input.ownerId, tx);
			const source = await loadAdmissionSource(input, tx);
			await enforceAdmissionBuckets(input, tx);
			const activeGuestJobs = await tx.generationJob.count({
				where: {
					ownerType: "USER",
					ownerId: input.ownerId,
					guestTrial: { promotionPeriod: input.promotionPeriod },
					status: { in: [...ACTIVE_GENERATION_JOB_STATUSES] },
				},
			});
			if (activeGuestJobs >= input.maximumActiveJobsPerGuest) {
				throw new Error("GUEST_OWNER_CAPACITY");
			}
			const [activeDeviceJobs, activeIpJobs] = await Promise.all([
				tx.generationJob.count({
					where: {
						serviceClass: "GUEST_SLOW",
						guestTrial: {
							promotionPeriod: input.promotionPeriod,
							deviceHash: input.deviceHash,
						},
						status: { in: [...ACTIVE_GENERATION_JOB_STATUSES] },
					},
				}),
				tx.generationJob.count({
					where: {
						serviceClass: "GUEST_SLOW",
						guestTrial: { promotionPeriod: input.promotionPeriod, ipHash: input.ipHash },
						status: { in: [...ACTIVE_GENERATION_JOB_STATUSES] },
					},
				}),
			]);
			if (activeDeviceJobs >= (input.maximumActiveJobsPerDevice ?? 1)) {
				throw new Error("GUEST_DEVICE_LIMIT");
			}
			if (activeIpJobs >= (input.maximumActiveJobsPerIp ?? 2)) {
				throw new Error("GUEST_IP_RATE_LIMIT");
			}

			const queueDepth = await tx.generationJob.count({
				where: {
					serviceClass: "GUEST_SLOW",
					guestTrial: { promotionPeriod: input.promotionPeriod },
					status: { in: [...ACTIVE_GENERATION_JOB_STATUSES] },
				},
			});
			if (queueDepth >= input.maximumGlobalQueueDepth) {
				throw new Error("GUEST_QUEUE_CAPACITY");
			}
			const riskAdmission = await guestRiskAdmissionAction(input, tx);
			if (riskAdmission === "REJECT") throw new Error("GUEST_RISK_CAPACITY");
			const resultExpiresAt = new Date(
				Math.min(input.now.getTime() + input.retentionMs, source.asset.deleteAfter!.getTime()),
			);
			const queueCapacity = input.queueCapacity ?? 1;
			const estimate = deriveGuestQueueEstimate({
				now: input.now,
				queueDepth: riskAdmission === "SLOW" ? Math.max(queueDepth, queueCapacity) : queueDepth,
				queueCapacity,
				serviceTimeMs: riskAdmission === "SLOW" ? input.serviceTimeMs * 2 : input.serviceTimeMs,
				immutableExpiry: resultExpiresAt,
			});
			if (!estimate) throw new Error("GUEST_QUEUE_CAPACITY");
			const { projectedDispatchAt, estimateExpiresAt } = estimate;
			if (projectedDispatchAt.getTime() - input.now.getTime() > input.queueTtlMs) {
				throw new Error("GUEST_QUEUE_CAPACITY");
			}
			if (resultExpiresAt <= projectedDispatchAt) {
				throw new Error("GUEST_QUEUE_CAPACITY");
			}

			await assertCanonicalGuestQuote(input, resolveCanonicalQuote);
			await holdQuotedRisk(input, resultExpiresAt, tx);
			const trial = await tx.guestMediaTrial.create({
				data: {
					ownerId: input.ownerId,
					promotionPeriod: input.promotionPeriod,
					eligibility: "IN_FLIGHT",
					sponsorCredits: input.sponsorCredits,
					sourceDraftId: input.sourceDraftId,
					sourceBootstrapId: input.sourceBootstrapId,
					sourceAssetId: input.sourceAssetId,
					sourceSessionHash: input.sourceSessionHash,
					deviceHash: input.deviceHash,
					ipHash: input.ipHash,
					subnetHash: input.subnetHash,
					capabilityVersion: input.capabilityVersion,
					idempotencyFingerprint: input.idempotencyFingerprint,
					abuseEvidenceExpiresAt: new Date(input.now.getTime() + input.abuseEvidenceTtlMs),
					abuseEvidenceDeletedAt: null,
					frozenQuotedRiskMicros: input.quote.costMicros ?? 0n,
					riskState: "HELD",
					projectedDispatchAt,
					estimateExpiresAt,
					expiresAt: resultExpiresAt,
				},
			});
			const account = await tx.creditAccount.create({
				data: { ownerType: "USER", ownerId: input.ownerId },
			});
			await createCreditGrant(
				{
					accountId: account.id,
					amount: input.sponsorCredits,
					referenceKey: `guest-trial:${trial.id}:grant`,
					expiresAt: resultExpiresAt,
					metadata: { guestTrialId: trial.id, promotionPeriod: input.promotionPeriod },
				},
				tx,
			);
			const quote = await createModeratedGenerationQuote(input.quote, tx);
			const job = await tx.generationJob.create({
				data: {
					ownerType: "USER",
					ownerId: input.ownerId,
					submittedByUserId: input.ownerId,
					quoteId: quote.id,
					idempotencyKey: input.idempotencyKey,
					productKey: quote.productKey,
					catalogVersion: quote.catalogVersion,
					pricingVersion: quote.pricingVersion,
					creditsReserved: quote.credits,
					inputSnapshot: input.quote.inputSnapshot,
					pricingSnapshot: input.quote.pricingSnapshot ?? {},
					serviceClass: "GUEST_SLOW",
					dispatchEligibleAt: projectedDispatchAt,
					guestTrialId: trial.id,
				},
			});
			await reserveCreditsInTransaction(
				{
					accountId: account.id,
					jobId: job.id,
					amount: input.sponsorCredits,
					referenceKey: `job:${job.id}:reserve`,
				},
				tx,
			);
			await tx.generationJobAsset.create({
				data: {
					jobId: job.id,
					assetId: input.sourceAssetId,
					assetChecksum: input.sourceAssetChecksum,
					role: "INPUT",
					position: 0,
				},
			});
			await tx.guestMediaTrial.update({
				where: { id: trial.id },
				data: { currentJobId: job.id },
			});
			await tx.outboxEvent.create({
				data: {
					eventType: GUEST_GENERATION_ELIGIBLE_EVENT,
					aggregateType: "GENERATION_JOB",
					aggregateId: job.id,
					dedupeKey: `guest-job:${job.id}:eligible`,
					payload: { jobId: job.id, trialId: trial.id },
					availableAt: projectedDispatchAt,
				},
			});
			return {
				jobId: job.id,
				trialId: trial.id,
				stage: "WAITING",
				projectedDispatchAt,
				estimateExpiresAt,
				resultExpiresAt,
				resultAssetId: null,
				watermarked: false,
				trialConsumed: false,
				linkReady: true,
			};
		});
	} catch (error) {
		if (isDatabaseUniqueConflict(error) || isErrorCode(error, "TURNSTILE_REPLAYED")) {
			const replay = await findGuestAdmissionReplay(input, client);
			if (replay) return replay;
		}
		const denialReason = guestAdmissionDenialReason(error);
		if (denialReason) {
			await recordGuestAdmissionDenial(
				{
					promotionPeriod: input.promotionPeriod,
					reason: denialReason,
					subjectHash: input.idempotencyFingerprint,
					now: input.now,
					evidenceTtlMs: input.abuseEvidenceTtlMs,
				},
				client,
			).catch(() => undefined);
		}
		throw error;
	}
}

async function assertCanonicalGuestQuote(
	input: CreateGuestGenerationTransactionInput,
	resolveCanonicalQuote: ResolveCanonicalGuestGenerationQuote,
): Promise<void> {
	let canonical: CanonicalGuestGenerationQuote;
	try {
		canonical = await resolveCanonicalQuote({
			productKey: "image-fast",
			inputSnapshot: input.quote.inputSnapshot,
		});
	} catch {
		throw new Error("GUEST_PRICE_CHANGED");
	}
	const canonicalPayload = {
		...input.quote,
		productKey: canonical.productKey,
		catalogVersion: canonical.catalogVersion,
		pricingVersion: canonical.pricingVersion,
		credits: canonical.credits,
		costMicros: canonical.costMicros,
		pricingSnapshot: canonical.pricingSnapshot,
	};
	if (
		canonical.productKey !== "image-fast" ||
		canonical.catalogVersion !== input.quote.catalogVersion ||
		canonical.pricingVersion !== input.quote.pricingVersion ||
		canonical.credits !== 4n ||
		canonical.credits !== input.sponsorCredits ||
		canonical.credits !== input.quote.credits ||
		canonical.costMicros <= 0n ||
		canonical.costMicros !== (input.quote.costMicros ?? 0n) ||
		fingerprintGenerationQuoteSecurityPayload(canonicalPayload) !==
			fingerprintGenerationQuoteSecurityPayload(input.quote)
	) {
		throw new Error("GUEST_PRICE_CHANGED");
	}
}

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && error.message === code;
}

export async function getGuestJobSnapshot(
	input: {
		ownerId: string;
		jobId: string;
		now: Date;
		verification: { provider: string; ruleVersion: string; policyVersion: string };
	},
	client: MediaTransactionClient,
): Promise<GuestJobSnapshot | null> {
	const job = await client.generationJob.findFirst({
		where: {
			id: input.jobId,
			ownerType: "USER",
			ownerId: input.ownerId,
			productKey: "image-fast",
			serviceClass: "GUEST_SLOW",
			guestTrialId: { not: null },
		},
		include: {
			guestTrial: { include: { linkIntents: { take: 1, select: { state: true } } } },
			assets: {
				where: { role: "OUTPUT" },
				include: {
					asset: {
						include: {
							moderationResults: {
								orderBy: [
									{ verificationGeneration: "desc" },
									{ attemptNumber: "desc" },
									{ createdAt: "desc" },
									{ id: "desc" },
								],
								take: 1,
							},
						},
					},
				},
				orderBy: [{ position: "asc" }, { createdAt: "asc" }],
			},
		},
	});
	const trial = job?.guestTrial;
	if (
		!job ||
		!trial ||
		trial.ownerId !== input.ownerId ||
		(job.id !== trial.currentJobId && job.id !== trial.consumedJobId)
	) {
		return null;
	}
	const outputBinding = job.assets[0];
	const output = outputBinding?.asset;
	const watermarked = Boolean(
		job.status === "SUCCEEDED" &&
		isGuestWatermarkedOutput(outputBinding, input.ownerId, trial.expiresAt, input.now) &&
		output &&
		hasCurrentApprovedMediaAssetEvidence(output, { ...input.verification, now: input.now }),
	);
	return {
		jobId: job.id,
		stage:
			job.status === "SUCCEEDED" && !watermarked
				? "FINISHING"
				: guestStage(job.status, trial.expiresAt, input.now),
		projectedDispatchAt: trial.projectedDispatchAt,
		estimateExpiresAt: trial.estimateExpiresAt,
		resultExpiresAt: trial.expiresAt,
		resultAssetId: watermarked ? output!.id : null,
		watermarked,
		trialConsumed: trial.eligibility === "CONSUMED" || trial.consumedJobId !== null,
		linkReady: trial.expiresAt > input.now && trial.linkIntents.length === 0,
	};
}

export async function getRegisteredGuestJobSnapshot(
	input: {
		registeredUserId: string;
		jobId: string;
		now: Date;
		verification: { provider: string; ruleVersion: string; policyVersion: string };
	},
	client: MediaTransactionClient,
): Promise<GuestJobSnapshot | null> {
	const grant = await client.guestResultAccessGrant.findFirst({
		where: {
			registeredUserId: input.registeredUserId,
			guestJobId: input.jobId,
			expiresAt: { gt: input.now },
			trial: { expiresAt: { gt: input.now } },
			guestJob: { serviceClass: "GUEST_SLOW", productKey: "image-fast" },
		},
		include: { trial: true, guestJob: { select: { guestTrialId: true } } },
	});
	if (
		!grant ||
		grant.trial.ownerId === null ||
		grant.trialId !== grant.guestJob.guestTrialId ||
		grant.expiresAt.getTime() !== grant.trial.expiresAt.getTime()
	) {
		return null;
	}
	return getGuestJobSnapshot(
		{
			ownerId: grant.trial.ownerId,
			jobId: input.jobId,
			now: input.now,
			verification: input.verification,
		},
		client,
	);
}

export async function getGuestOwnedResultAssetForAccess(
	input: {
		ownerId: string;
		jobId: string;
		assetId: string;
		now: Date;
		verification: { provider: string; ruleVersion: string; policyVersion: string };
	},
	client: MediaTransactionClient,
): Promise<GuestGrantedAsset | null> {
	const binding = await client.generationJobAsset.findFirst({
		where: {
			jobId: input.jobId,
			assetId: input.assetId,
			role: "OUTPUT",
			job: {
				ownerType: "USER",
				ownerId: input.ownerId,
				productKey: "image-fast",
				serviceClass: "GUEST_SLOW",
				status: "SUCCEEDED",
				guestTrial: { is: { ownerId: input.ownerId, expiresAt: { gt: input.now } } },
			},
		},
		include: {
			job: { include: { guestTrial: true } },
			asset: {
				include: {
					moderationResults: {
						orderBy: [
							{ verificationGeneration: "desc" },
							{ attemptNumber: "desc" },
							{ createdAt: "desc" },
							{ id: "desc" },
						],
						take: 1,
					},
				},
			},
		},
	});
	if (!binding?.job.guestTrial) return null;
	return guestAccessAsset(binding, binding.job.guestTrial.expiresAt, input, input.ownerId);
}

export async function getRegisteredGuestResultAssetForAccess(
	input: {
		registeredUserId: string;
		jobId?: string;
		assetId: string;
		now: Date;
		verification: { provider: string; ruleVersion: string; policyVersion: string };
	},
	client: MediaTransactionClient,
): Promise<GuestGrantedAsset | null> {
	const grant = await client.guestResultAccessGrant.findFirst({
		where: {
			registeredUserId: input.registeredUserId,
			expiresAt: { gt: input.now },
			...(input.jobId ? { guestJobId: input.jobId } : {}),
			trial: { expiresAt: { gt: input.now } },
			guestJob: {
				productKey: "image-fast",
				serviceClass: "GUEST_SLOW",
				status: "SUCCEEDED",
				assets: { some: { assetId: input.assetId, role: "OUTPUT" } },
			},
		},
		include: {
			trial: true,
			guestJob: {
				include: {
					assets: {
						where: { assetId: input.assetId, role: "OUTPUT" },
						include: {
							asset: {
								include: {
									moderationResults: {
										orderBy: [
											{ verificationGeneration: "desc" },
											{ attemptNumber: "desc" },
											{ createdAt: "desc" },
											{ id: "desc" },
										],
										take: 1,
									},
								},
							},
						},
					},
				},
			},
		},
	});
	const binding = grant?.guestJob.assets[0];
	if (
		!grant ||
		!binding ||
		grant.trial.ownerId === null ||
		grant.trialId !== grant.guestJob.guestTrialId ||
		grant.expiresAt.getTime() !== grant.trial.expiresAt.getTime()
	) {
		return null;
	}
	return guestAccessAsset(binding, grant.expiresAt, input, grant.trial.ownerId);
}

type GuestAccessBinding = Prisma.GenerationJobAssetGetPayload<{
	include: { asset: { include: { moderationResults: true } } };
}>;

function guestAccessAsset(
	binding: GuestAccessBinding,
	resultExpiresAt: Date,
	input: {
		assetId: string;
		now: Date;
		verification: { provider: string; ruleVersion: string; policyVersion: string };
	},
	anonymousOwnerId: string,
): GuestGrantedAsset | null {
	const asset = binding.asset;
	if (
		asset.id !== input.assetId ||
		asset.ownerType !== "USER" ||
		asset.ownerId !== anonymousOwnerId ||
		asset.kind !== "OUTPUT" ||
		asset.status !== "READY" ||
		asset.retentionClass !== "GUEST_TRIAL" ||
		asset.deletedAt !== null ||
		asset.checksum !== binding.assetChecksum ||
		!asset.watermarkVersion ||
		!asset.watermarkedAt ||
		!asset.cleanStagingDeletedAt ||
		!asset.deleteAfter ||
		asset.deleteAfter <= input.now ||
		asset.deleteAfter > resultExpiresAt ||
		!hasCurrentApprovedMediaAssetEvidence(asset, { ...input.verification, now: input.now }) ||
		!asset.verificationValidUntil
	) {
		return null;
	}
	return {
		id: asset.id,
		objectKey: asset.objectKey,
		verificationValidUntil: asset.verificationValidUntil,
		deleteAfter: asset.deleteAfter,
		resultExpiresAt,
	};
}

export async function lockGuestOwnerPromotion(
	tx: Prisma.TransactionClient,
	ownerId: string,
	promotionPeriod: string,
): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`guest-owner-promotion:${ownerId}:${promotionPeriod}`}, 0))`;
}

async function acquireGuestAdmissionLocks(
	input: CreateGuestGenerationTransactionInput,
	tx: Prisma.TransactionClient,
): Promise<void> {
	for (const key of [
		`guest-promotion:${input.promotionPeriod}`,
		`guest-ip:${input.ipHash}`,
		`guest-subnet:${input.subnetHash}`,
		`guest-device:${input.deviceHash}`,
	]) {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
	}
	await lockGuestOwnerPromotion(tx, input.ownerId, input.promotionPeriod);
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`guest-idempotency:${input.ownerId}:${input.idempotencyKey}`}, 0))`;
}

async function findGuestAdmissionReplay(
	input: CreateGuestGenerationTransactionInput,
	client: Prisma.TransactionClient | MediaTransactionClient,
): Promise<CreateGuestGenerationTransactionResult | null> {
	const existing = await client.generationJob.findUnique({
		where: {
			ownerType_ownerId_idempotencyKey: {
				ownerType: "USER",
				ownerId: input.ownerId,
				idempotencyKey: input.idempotencyKey,
			},
		},
		include: {
			quote: true,
			guestTrial: { include: { linkIntents: { take: 1, select: { state: true } } } },
			assets: {
				include: {
					asset: {
						include: {
							moderationResults: {
								orderBy: [
									{ verificationGeneration: "desc" },
									{ attemptNumber: "desc" },
									{ createdAt: "desc" },
									{ id: "desc" },
								],
								take: 1,
							},
						},
					},
				},
			},
		},
	});
	if (!existing) return null;
	const trial = existing.guestTrial;
	const binding = existing.assets.find((asset) => asset.role === "INPUT");
	if (
		!trial ||
		trial.ownerId !== input.ownerId ||
		trial.promotionPeriod !== input.promotionPeriod ||
		trial.idempotencyFingerprint !== input.idempotencyFingerprint ||
		existing.productKey !== "image-fast" ||
		existing.serviceClass !== "GUEST_SLOW" ||
		existing.quote.inputFingerprint !== input.quote.moderation.inputFingerprint ||
		binding?.assetId !== input.sourceAssetId ||
		binding.assetChecksum !== input.sourceAssetChecksum
	) {
		throw new Error("IDEMPOTENCY_CONFLICT");
	}
	const outputBinding = existing.assets.find((asset) => asset.role === "OUTPUT");
	const output = outputBinding?.asset;
	const watermarked = Boolean(
		existing.status === "SUCCEEDED" &&
		isGuestWatermarkedOutput(outputBinding, input.ownerId, trial.expiresAt, input.now) &&
		output &&
		hasCurrentApprovedMediaAssetEvidence(output, { ...input.assetModeration, now: input.now }),
	);
	return {
		jobId: existing.id,
		trialId: trial.id,
		stage:
			existing.status === "SUCCEEDED" && !watermarked
				? "FINISHING"
				: guestStage(existing.status, trial.expiresAt, input.now),
		projectedDispatchAt: trial.projectedDispatchAt,
		estimateExpiresAt: trial.estimateExpiresAt,
		resultExpiresAt: trial.expiresAt,
		resultAssetId: watermarked ? output!.id : null,
		watermarked,
		trialConsumed: trial.eligibility === "CONSUMED" || trial.consumedJobId !== null,
		linkReady: trial.expiresAt > input.now && trial.linkIntents.length === 0,
	};
}

function isGuestWatermarkedOutput(
	binding:
		| {
				assetChecksum: string;
				asset: {
					ownerType: string;
					ownerId: string;
					kind: string;
					status: string;
					retentionClass: string;
					checksum: string | null;
					watermarkVersion: string | null;
					watermarkedAt: Date | null;
					cleanStagingDeletedAt: Date | null;
					verificationValidUntil: Date | null;
					deleteAfter: Date | null;
					deletedAt: Date | null;
				};
		  }
		| undefined,
	ownerId: string,
	resultExpiresAt: Date,
	now: Date,
): boolean {
	const asset = binding?.asset;
	return Boolean(
		asset &&
		asset.ownerType === "USER" &&
		asset.ownerId === ownerId &&
		asset.kind === "OUTPUT" &&
		asset.status === "READY" &&
		asset.retentionClass === "GUEST_TRIAL" &&
		asset.deletedAt === null &&
		asset.checksum &&
		asset.checksum === binding.assetChecksum &&
		asset.watermarkVersion &&
		asset.watermarkedAt &&
		asset.cleanStagingDeletedAt &&
		asset.verificationValidUntil &&
		asset.verificationValidUntil > now &&
		asset.deleteAfter &&
		asset.deleteAfter > now &&
		asset.deleteAfter <= resultExpiresAt,
	);
}

async function assertAnonymousOwner(ownerId: string, tx: Prisma.TransactionClient): Promise<void> {
	const owner = await tx.user.findUnique({ where: { id: ownerId }, select: { isAnonymous: true } });
	if (!owner?.isAnonymous) throw new Error("GUEST_OWNER_UNAVAILABLE");
}

async function loadAdmissionSource(
	input: CreateGuestGenerationTransactionInput,
	tx: Prisma.TransactionClient,
) {
	const bootstrap = await tx.guestSessionBootstrap.findFirst({
		where: {
			id: input.sourceBootstrapId,
			ownerId: input.ownerId,
			promotionPeriod: input.promotionPeriod,
			claimedDraftId: input.sourceDraftId,
			sourceAssetId: input.sourceAssetId,
			completedAt: { not: null },
			expiresAt: { gt: input.now },
		},
		include: {
			claimedDraft: true,
			sourceAsset: {
				include: {
					moderationResults: {
						orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
						take: 1,
					},
				},
			},
		},
	});
	const draft = bootstrap?.claimedDraft;
	const asset = bootstrap?.sourceAsset;
	const evidence = asset?.moderationResults[0];
	if (
		!bootstrap ||
		!draft ||
		draft.ownerType !== "USER" ||
		draft.ownerId !== input.ownerId ||
		draft.submittedByUserId !== input.ownerId ||
		draft.status !== "SUBMITTED" ||
		draft.assetId !== input.sourceAssetId ||
		!asset ||
		asset.ownerType !== "USER" ||
		asset.ownerId !== input.ownerId ||
		asset.kind !== "INPUT" ||
		asset.status !== "READY" ||
		asset.retentionClass !== "GUEST_TRIAL" ||
		asset.deletedAt !== null ||
		asset.deleteAfter === null ||
		asset.deleteAfter <= input.now ||
		asset.byteSize > BigInt(input.maximumBytes) ||
		asset.checksum !== input.sourceAssetChecksum ||
		evidence?.status !== "APPROVED" ||
		evidence.assetChecksum !== asset.checksum ||
		evidence.verificationGeneration !== asset.verificationGeneration ||
		evidence.attemptNumber !== asset.verificationAttemptCount ||
		evidence.evidenceKind !== asset.kind ||
		evidence.provider !== input.assetModeration.provider ||
		evidence.provider !== asset.verificationProvider ||
		evidence.providerTaskId !== asset.verificationProviderTaskId ||
		evidence.ruleVersion !== input.assetModeration.ruleVersion ||
		evidence.ruleVersion !== asset.verificationRuleVersion ||
		evidence.policyVersion !== input.assetModeration.policyVersion ||
		evidence.policyVersion !== asset.verificationPolicyVersion ||
		evidence.validUntil === null ||
		evidence.validUntil <= input.now ||
		asset.verificationValidUntil === null ||
		asset.verificationValidUntil.getTime() !== evidence.validUntil.getTime()
	) {
		throw new Error("GUEST_INPUT_UNAVAILABLE");
	}
	return { bootstrap, draft, asset };
}

async function enforceAdmissionBuckets(
	input: CreateGuestGenerationTransactionInput,
	tx: Prisma.TransactionClient,
): Promise<void> {
	const minuteStart = new Date(Math.floor(input.now.getTime() / 60_000) * 60_000);
	const tenMinuteStart = new Date(Math.floor(input.now.getTime() / 600_000) * 600_000);
	const hourStart = new Date(Math.floor(input.now.getTime() / 3_600_000) * 3_600_000);
	const dayStart = new Date(Math.floor(input.now.getTime() / 86_400_000) * 86_400_000);
	const evidenceTtlMs = input.abuseEvidenceTtlMs;
	if (
		!(await incrementGuestBucket(
			tx,
			"guest-generate-global-minute",
			"global",
			minuteStart,
			60_000,
			input.maximumGlobalRequestsPerMinute ?? input.maximumRequestsPerMinute,
			evidenceTtlMs,
		))
	) {
		throw new Error("GUEST_GLOBAL_RATE_LIMIT");
	}
	if (
		!(await incrementGuestBucket(
			tx,
			"guest-generate-global-hour",
			"global",
			hourStart,
			3_600_000,
			input.maximumGlobalRequestsPerHour ?? input.maximumRequestsPerIpPerHour,
			evidenceTtlMs,
		))
	) {
		throw new Error("GUEST_GLOBAL_RATE_LIMIT");
	}
	if (
		!(await incrementGuestBucket(
			tx,
			"guest-generate-global-day",
			"global",
			dayStart,
			86_400_000,
			input.maximumGlobalRequestsPerDay ?? input.maximumRequestsPerIpPerHour,
			evidenceTtlMs,
		))
	) {
		throw new Error("GUEST_GLOBAL_RATE_LIMIT");
	}
	if (
		!(await incrementGuestBucket(
			tx,
			"guest-generate-ip-ten-minute",
			input.ipHash,
			tenMinuteStart,
			600_000,
			input.maximumRequestsPerIpPerTenMinutes ?? input.maximumRequestsPerIpPerHour,
			evidenceTtlMs,
		))
	) {
		throw new Error("GUEST_IP_RATE_LIMIT");
	}
	if (
		!(await incrementGuestBucket(
			tx,
			"guest-generate-ip-day",
			input.ipHash,
			dayStart,
			86_400_000,
			input.maximumRequestsPerIpPerDay ?? input.maximumRequestsPerIpPerHour,
			evidenceTtlMs,
		))
	) {
		throw new Error("GUEST_IP_RATE_LIMIT");
	}
	if (
		!(await incrementGuestBucket(
			tx,
			"guest-generate-subnet-day",
			input.subnetHash,
			dayStart,
			86_400_000,
			input.maximumRequestsPerSubnetPerDay ?? input.maximumRequestsPerIpPerHour,
			evidenceTtlMs,
		))
	) {
		throw new Error("GUEST_SUBNET_RATE_LIMIT");
	}
}

async function guestRiskAdmissionAction(
	input: CreateGuestGenerationTransactionInput,
	tx: Prisma.TransactionClient,
): Promise<"OPEN" | "SLOW" | "REJECT"> {
	const existing = await tx.guestRiskBudgetBucket.findUnique({
		where: {
			promotionPeriod_subjectHash: {
				promotionPeriod: input.promotionPeriod,
				subjectHash: "global",
			},
		},
	});
	const hardLimit = existing
		? existing.hardLimitMicros < input.riskBudgetMicros
			? existing.hardLimitMicros
			: input.riskBudgetMicros
		: input.riskBudgetMicros;
	const projectedRiskMicros =
		(existing?.reservedMicros ?? 0n) +
		(existing?.consumedMicros ?? 0n) +
		(input.quote.costMicros ?? 0n);
	if (hardLimit <= 0n || projectedRiskMicros * 100n >= hardLimit * 90n) return "REJECT";
	if (projectedRiskMicros * 100n >= hardLimit * 75n) return "SLOW";
	return "OPEN";
}

async function holdQuotedRisk(
	input: CreateGuestGenerationTransactionInput,
	expiresAt: Date,
	tx: Prisma.TransactionClient,
): Promise<void> {
	const risk = input.quote.costMicros ?? 0n;
	const existing = await tx.guestRiskBudgetBucket.findUnique({
		where: {
			promotionPeriod_subjectHash: {
				promotionPeriod: input.promotionPeriod,
				subjectHash: "global",
			},
		},
	});
	const hardLimit = existing
		? existing.hardLimitMicros < input.riskBudgetMicros
			? existing.hardLimitMicros
			: input.riskBudgetMicros
		: input.riskBudgetMicros;
	const aggregateExpiresAt =
		existing && existing.expiresAt > expiresAt ? existing.expiresAt : expiresAt;
	if (
		risk <= 0n ||
		(existing?.reservedMicros ?? 0n) + (existing?.consumedMicros ?? 0n) + risk > hardLimit
	) {
		throw new Error("GUEST_RISK_CAPACITY");
	}
	await tx.guestRiskBudgetBucket.upsert({
		where: {
			promotionPeriod_subjectHash: {
				promotionPeriod: input.promotionPeriod,
				subjectHash: "global",
			},
		},
		create: {
			promotionPeriod: input.promotionPeriod,
			subjectHash: "global",
			reservedMicros: risk,
			hardLimitMicros: hardLimit,
			expiresAt: aggregateExpiresAt,
		},
		update: {
			reservedMicros: { increment: risk },
			hardLimitMicros: hardLimit,
			expiresAt: aggregateExpiresAt,
			version: { increment: 1 },
		},
	});
}

function guestAdmissionDenialReason(error: unknown): GuestAdmissionDenialReason | null {
	if (!(error instanceof Error)) return null;
	const reasonByCode: Partial<Record<string, GuestAdmissionDenialReason>> = {
		GUEST_DEVICE_LIMIT: "DEVICE_LIMIT",
		GUEST_GLOBAL_RATE_LIMIT: "GLOBAL_RATE_LIMIT",
		GUEST_INPUT_UNAVAILABLE: "INPUT",
		GUEST_IP_RATE_LIMIT: "IP_RATE_LIMIT",
		GUEST_LINK_IN_PROGRESS: "TRIAL_UNAVAILABLE",
		GUEST_OWNER_CAPACITY: "OWNER_CAPACITY",
		GUEST_PRICE_CHANGED: "QUOTE",
		GUEST_QUEUE_CAPACITY: "QUEUE_CAPACITY",
		GUEST_RISK_CAPACITY: "RISK_CAPACITY",
		GUEST_SUBNET_RATE_LIMIT: "SUBNET_RATE_LIMIT",
		GUEST_TRIAL_UNAVAILABLE: "TRIAL_UNAVAILABLE",
		TURNSTILE_REPLAYED: "TURNSTILE_REPLAY",
	};
	return reasonByCode[error.message] ?? null;
}

function validateAdmissionInput(input: CreateGuestGenerationTransactionInput): void {
	if (
		!input.ownerId ||
		!input.promotionPeriod ||
		!input.capabilityVersion ||
		!input.idempotencyKey.trim() ||
		!/^\w[\w.-]{7,127}$/.test(input.idempotencyKey) ||
		![
			input.sourceSessionHash,
			input.deviceHash,
			input.ipHash,
			input.subnetHash,
			input.idempotencyFingerprint,
			input.sourceAssetChecksum,
			input.turnstile.tokenHash,
		].every((value) => /^[a-f0-9]{64}$/.test(value)) ||
		input.sponsorCredits !== 4n ||
		input.quote.credits !== input.sponsorCredits ||
		input.quote.productKey !== "image-fast" ||
		input.quote.ownerType !== "USER" ||
		input.quote.ownerId !== input.ownerId ||
		input.quote.submittedByUserId !== input.ownerId
	) {
		throw new Error("GUEST_PRICE_CHANGED");
	}
	for (const value of [
		input.retentionMs,
		input.queueTtlMs,
		input.serviceTimeMs,
		input.queueCapacity ?? 1,
		input.maximumBytes,
		input.maximumGlobalQueueDepth,
		input.maximumActiveJobsPerGuest,
		input.maximumRequestsPerMinute,
		input.maximumRequestsPerIpPerHour,
		input.maximumAcceptedTrialsPerSession ?? 1,
		input.maximumActiveJobsPerDevice ?? 1,
		input.maximumAcceptedTrialsPerDevicePromotion ?? 1,
		input.maximumActiveJobsPerIp ?? 2,
		input.maximumRequestsPerIpPerTenMinutes ?? input.maximumRequestsPerIpPerHour,
		input.maximumRequestsPerIpPerDay ?? input.maximumRequestsPerIpPerHour,
		input.maximumRequestsPerSubnetPerDay ?? input.maximumRequestsPerIpPerHour,
		input.maximumGlobalRequestsPerMinute ?? input.maximumRequestsPerMinute,
		input.maximumGlobalRequestsPerHour ?? input.maximumRequestsPerIpPerHour,
		input.maximumGlobalRequestsPerDay ?? input.maximumRequestsPerIpPerHour,
		input.abuseEvidenceTtlMs,
	]) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error("GUEST_CONFIGURATION_ERROR");
	}
	if (
		input.riskBudgetMicros <= 0n ||
		input.quote.expiresAt <= input.now ||
		Number.isNaN(input.turnstile.challengeTimestamp.getTime()) ||
		input.turnstile.expiresAt <= input.turnstile.challengeTimestamp ||
		input.turnstile.expiresAt <= input.now
	) {
		throw new Error("GUEST_CONFIGURATION_ERROR");
	}
}

function guestStage(status: string, expiresAt: Date, now: Date): GuestJobStage {
	if (expiresAt <= now) return "EXPIRED";
	if (status === "RESERVED") return "WAITING";
	if (["DISPATCH_QUEUED", "SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"].includes(status)) {
		return "EDITING";
	}
	if (["NEEDS_RECONCILIATION", "FINALIZING"].includes(status)) return "FINISHING";
	if (status === "SUCCEEDED") return "READY";
	return "FAILED";
}
