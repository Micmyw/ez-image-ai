import type { Prisma } from "../../generated/client";
import { transferGuestGenerationDraftToRegisteredUserInTransaction } from "./drafts";
import { lockGuestOwnerPromotion } from "./guest-admission";
import type { MediaTransactionClient } from "./types";
import { runReadCommitted, runSerializable } from "./types";

const GUEST_RETURN_PATHS = ["/try", "/create", "/pricing"] as const;

export type GuestReturnPath = (typeof GUEST_RETURN_PATHS)[number];

export interface BeginGuestLinkIntentTransactionInput {
	anonymousOwnerId: string;
	promotionPeriod: string;
	sourceSessionHash: string;
	deviceHash: string;
	returnPath: GuestReturnPath;
	idempotencyKey: string;
	tokenHash: string;
	now: Date;
	expiresAt: Date;
}

export interface GuestLinkIntentSnapshot {
	id: string;
	state: "LINKING" | "LINKED";
	trialId: string | null;
	claimedDraftId: string | null;
	returnPath: GuestReturnPath;
	expiresAt: Date;
}

export type CompleteGuestLinkIntentTransactionResult =
	| { mode: "DRAFT"; draftId: string; returnPath: GuestReturnPath }
	| {
			mode: "RESULT";
			jobId: string;
			returnPath: GuestReturnPath;
			expiresAt: Date;
	  };

export async function beginGuestLinkIntentTransaction(
	input: BeginGuestLinkIntentTransactionInput,
	client: MediaTransactionClient,
): Promise<GuestLinkIntentSnapshot> {
	validateBeginLinkInput(input);
	return runReadCommitted(client, async (tx) => {
		await lockGuestOwnerPromotion(tx, input.anonymousOwnerId, input.promotionPeriod);
		const existing = await tx.guestLinkIntent.findUnique({
			where: {
				anonymousOwnerId_promotionPeriod: {
					anonymousOwnerId: input.anonymousOwnerId,
					promotionPeriod: input.promotionPeriod,
				},
			},
		});
		if (existing) return assertLinkIntentReplay(existing, input);

		const anonymousOwner = await tx.user.findUnique({
			where: { id: input.anonymousOwnerId },
			select: { isAnonymous: true },
		});
		if (!anonymousOwner?.isAnonymous) throw new Error("GUEST_LINK_UNAVAILABLE");

		const trial = await tx.guestMediaTrial.findUnique({
			where: {
				ownerId_promotionPeriod: {
					ownerId: input.anonymousOwnerId,
					promotionPeriod: input.promotionPeriod,
				},
			},
			select: {
				id: true,
				sourceSessionHash: true,
				deviceHash: true,
				expiresAt: true,
			},
		});

		let trialId: string | null = null;
		let claimedDraftId: string | null = null;
		let returnPath: GuestReturnPath = input.returnPath;
		if (trial) {
			if (
				trial.sourceSessionHash !== input.sourceSessionHash ||
				trial.deviceHash !== input.deviceHash ||
				trial.expiresAt <= input.now
			) {
				throw new Error("GUEST_LINK_UNAVAILABLE");
			}
			trialId = trial.id;
			returnPath = "/try";
		} else {
			const bootstrap = await tx.guestSessionBootstrap.findFirst({
				where: {
					ownerId: input.anonymousOwnerId,
					promotionPeriod: input.promotionPeriod,
					completedAt: { not: null },
					expiresAt: { gt: input.now },
					claimedDraft: {
						is: {
							ownerType: "USER",
							ownerId: input.anonymousOwnerId,
							submittedByUserId: input.anonymousOwnerId,
							status: "SUBMITTED",
							expiresAt: { gt: input.now },
						},
					},
				},
				select: { claimedDraftId: true },
			});
			if (!bootstrap?.claimedDraftId) throw new Error("GUEST_LINK_UNAVAILABLE");
			claimedDraftId = bootstrap.claimedDraftId;
		}

		const intent = await tx.guestLinkIntent.create({
			data: {
				trialId,
				claimedDraftId,
				anonymousOwnerId: input.anonymousOwnerId,
				promotionPeriod: input.promotionPeriod,
				sourceSessionHash: input.sourceSessionHash,
				deviceHash: input.deviceHash,
				returnPath,
				state: "LINKING",
				tokenHash: input.tokenHash,
				idempotencyKey: input.idempotencyKey,
				createdAt: input.now,
				expiresAt: input.expiresAt,
			},
		});
		return toLinkIntentSnapshot(intent);
	});
}

export async function completeGuestLinkIntentTransaction(
	input: {
		tokenHash: string;
		registeredUserId: string;
		grantTokenHash: string;
		now: Date;
	},
	client: MediaTransactionClient,
): Promise<CompleteGuestLinkIntentTransactionResult> {
	if (!input.registeredUserId || !isSha256(input.tokenHash) || !isSha256(input.grantTokenHash)) {
		throw new Error("GUEST_LINK_UNAVAILABLE");
	}
	return runSerializable(client, async (tx) => {
		const candidate = await tx.guestLinkIntent.findUnique({
			where: { tokenHash: input.tokenHash },
			select: { anonymousOwnerId: true, promotionPeriod: true },
		});
		if (!candidate) throw new Error("GUEST_LINK_UNAVAILABLE");
		await lockGuestOwnerPromotion(tx, candidate.anonymousOwnerId, candidate.promotionPeriod);
		const intent = await tx.guestLinkIntent.findUnique({ where: { tokenHash: input.tokenHash } });
		if (!intent) throw new Error("GUEST_LINK_UNAVAILABLE");
		if (intent.state === "LINKED") {
			if (intent.registeredUserId !== input.registeredUserId) {
				throw new Error("GUEST_LINK_UNAVAILABLE");
			}
			return loadCompletedLinkResult(intent, tx);
		}
		if (intent.state !== "LINKING" || intent.expiresAt <= input.now) {
			throw new Error("GUEST_LINK_UNAVAILABLE");
		}
		const registeredUser = await tx.user.findUnique({
			where: { id: input.registeredUserId },
			select: { isAnonymous: true },
		});
		if (!registeredUser || registeredUser.isAnonymous) {
			throw new Error("GUEST_LINK_UNAVAILABLE");
		}

		let result: CompleteGuestLinkIntentTransactionResult;
		if (intent.claimedDraftId) {
			const draft = await transferGuestGenerationDraftToRegisteredUserInTransaction(
				{
					draftId: intent.claimedDraftId,
					anonymousOwnerId: intent.anonymousOwnerId,
					registeredUserId: input.registeredUserId,
					now: input.now,
				},
				tx,
			);
			result = {
				mode: "DRAFT",
				draftId: draft.id,
				returnPath: asGuestReturnPath(intent.returnPath),
			};
		} else if (intent.trialId) {
			const trial = await tx.guestMediaTrial.findFirst({
				where: {
					id: intent.trialId,
					ownerId: intent.anonymousOwnerId,
					promotionPeriod: intent.promotionPeriod,
					sourceSessionHash: intent.sourceSessionHash,
					deviceHash: intent.deviceHash,
					expiresAt: { gt: input.now },
					currentJobId: { not: null },
				},
				select: { id: true, currentJobId: true, expiresAt: true },
			});
			if (!trial?.currentJobId) throw new Error("GUEST_LINK_UNAVAILABLE");
			await tx.guestResultAccessGrant.create({
				data: {
					trialId: trial.id,
					guestJobId: trial.currentJobId,
					registeredUserId: input.registeredUserId,
					grantTokenHash: input.grantTokenHash,
					createdAt: input.now,
					expiresAt: trial.expiresAt,
				},
			});
			await tx.guestMediaTrial.update({
				where: { id: trial.id },
				data: { linkedAt: input.now },
			});
			result = {
				mode: "RESULT",
				jobId: trial.currentJobId,
				returnPath: "/try",
				expiresAt: trial.expiresAt,
			};
		} else {
			throw new Error("GUEST_LINK_UNAVAILABLE");
		}

		const linked = await tx.guestLinkIntent.updateMany({
			where: { id: intent.id, state: "LINKING", registeredUserId: null, linkedAt: null },
			data: {
				state: "LINKED",
				registeredUserId: input.registeredUserId,
				linkedAt: input.now,
			},
		});
		if (linked.count !== 1) throw new Error("GUEST_LINK_UNAVAILABLE");
		await tx.session.deleteMany({ where: { userId: intent.anonymousOwnerId } });
		return result;
	});
}

async function loadCompletedLinkResult(
	intent: {
		claimedDraftId: string | null;
		trialId: string | null;
		returnPath: string;
		registeredUserId: string | null;
	},
	tx: Prisma.TransactionClient,
): Promise<CompleteGuestLinkIntentTransactionResult> {
	if (intent.claimedDraftId) {
		return {
			mode: "DRAFT",
			draftId: intent.claimedDraftId,
			returnPath: asGuestReturnPath(intent.returnPath),
		};
	}
	if (intent.trialId && intent.registeredUserId) {
		const grant = await tx.guestResultAccessGrant.findFirst({
			where: { trialId: intent.trialId, registeredUserId: intent.registeredUserId },
			select: { guestJobId: true, expiresAt: true },
		});
		if (grant) {
			return {
				mode: "RESULT",
				jobId: grant.guestJobId,
				returnPath: "/try",
				expiresAt: grant.expiresAt,
			};
		}
	}
	throw new Error("GUEST_LINK_UNAVAILABLE");
}

function assertLinkIntentReplay(
	intent: {
		id: string;
		state: string;
		trialId: string | null;
		claimedDraftId: string | null;
		anonymousOwnerId: string;
		promotionPeriod: string;
		sourceSessionHash: string;
		deviceHash: string;
		returnPath: string;
		tokenHash: string;
		idempotencyKey: string;
		expiresAt: Date;
	},
	input: BeginGuestLinkIntentTransactionInput,
): GuestLinkIntentSnapshot {
	if (intent.state === "LINKED") throw new Error("GUEST_LINK_UNAVAILABLE");
	if (
		intent.anonymousOwnerId !== input.anonymousOwnerId ||
		intent.promotionPeriod !== input.promotionPeriod ||
		intent.sourceSessionHash !== input.sourceSessionHash ||
		intent.deviceHash !== input.deviceHash ||
		intent.tokenHash !== input.tokenHash ||
		intent.idempotencyKey !== input.idempotencyKey ||
		intent.returnPath !== (intent.trialId ? "/try" : input.returnPath) ||
		intent.state !== "LINKING" ||
		intent.expiresAt <= input.now
	) {
		throw new Error("GUEST_LINK_CONFLICT");
	}
	return toLinkIntentSnapshot(intent);
}

function toLinkIntentSnapshot(intent: {
	id: string;
	state: string;
	trialId: string | null;
	claimedDraftId: string | null;
	returnPath: string;
	expiresAt: Date;
}): GuestLinkIntentSnapshot {
	if (intent.state !== "LINKING" && intent.state !== "LINKED") {
		throw new Error("GUEST_LINK_UNAVAILABLE");
	}
	return {
		id: intent.id,
		state: intent.state,
		trialId: intent.trialId,
		claimedDraftId: intent.claimedDraftId,
		returnPath: asGuestReturnPath(intent.returnPath),
		expiresAt: intent.expiresAt,
	};
}

function validateBeginLinkInput(input: BeginGuestLinkIntentTransactionInput): void {
	if (
		!input.anonymousOwnerId ||
		!input.promotionPeriod ||
		!input.idempotencyKey.trim() ||
		!isSha256(input.sourceSessionHash) ||
		!isSha256(input.deviceHash) ||
		!isSha256(input.tokenHash) ||
		!GUEST_RETURN_PATHS.includes(input.returnPath) ||
		input.expiresAt <= input.now
	) {
		throw new Error("GUEST_LINK_UNAVAILABLE");
	}
}

function asGuestReturnPath(value: string): GuestReturnPath {
	if (!GUEST_RETURN_PATHS.includes(value as GuestReturnPath)) {
		throw new Error("GUEST_LINK_UNAVAILABLE");
	}
	return value as GuestReturnPath;
}

function isSha256(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}
