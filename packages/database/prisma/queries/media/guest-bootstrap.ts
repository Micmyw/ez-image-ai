import type { Prisma } from "../../generated/client";
import {
	createMediaUploadSessionTransaction,
	type CreateMediaUploadSessionTransactionInput,
} from "./assets";
import type { MediaTransactionClient } from "./types";
import { isDatabaseUniqueConflict } from "./types";

export const GUEST_RUNTIME_CONFIG_KEY = "media.guestGeneration.enabled";

export interface GuestRuntimeConfigOverride {
	enabled: true;
	version: number;
}

export async function resolveGuestRuntimeConfigOverride(
	client: MediaTransactionClient,
): Promise<GuestRuntimeConfigOverride | null> {
	const override = await client.runtimeConfigOverride.findFirst({
		where: {
			configKey: GUEST_RUNTIME_CONFIG_KEY,
			active: true,
			revertedAt: null,
		},
		orderBy: { version: "desc" },
		select: { value: true, version: true },
	});
	return override?.value === true ? { enabled: true, version: override.version } : null;
}

export async function consumeGuestTurnstileTokenHash(
	input: { tokenHash: string; challengeTimestamp: Date; expiresAt: Date },
	client: MediaTransactionClient,
): Promise<boolean> {
	try {
		await client.guestAbuseBucket.create({
			data: {
				scope: "guest-turnstile-token",
				subjectHash: input.tokenHash,
				windowStart: new Date(0),
				windowEnd: input.expiresAt,
				expiresAt: input.expiresAt,
				requestCount: 1n,
				rejectionCount: 0n,
				updatedAt: input.challengeTimestamp,
			},
		});
		return true;
	} catch (error) {
		if (isDatabaseUniqueConflict(error)) return false;
		throw error;
	}
}

export interface CreateGuestMediaUploadIntentTransactionInput extends Omit<
	CreateMediaUploadSessionTransactionInput,
	"guest" | "tokenHash"
> {
	capabilityVersion: string;
	originHash: string;
	expectedSha256: string;
	deleteAfter: Date;
	ipHash: string;
	subnetHash: string;
	abuseLimits: {
		maximumRequestsPerMinute: number;
		maximumRequestsPerIpPerHour: number;
		maximumGlobalQueueDepth: number;
	};
	completionTokenHash: string;
}

export async function createGuestMediaUploadIntentTransaction(
	input: CreateGuestMediaUploadIntentTransactionInput,
	client: MediaTransactionClient,
) {
	const now = new Date();
	await client.$transaction(async (tx) => {
		const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
		const hourStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
		const checks = [
			await incrementGuestBucket(
				tx,
				"guest-upload-ip-minute",
				input.ipHash,
				minuteStart,
				60_000,
				input.abuseLimits.maximumRequestsPerMinute,
			),
			await incrementGuestBucket(
				tx,
				"guest-upload-ip-hour",
				input.ipHash,
				hourStart,
				3_600_000,
				input.abuseLimits.maximumRequestsPerIpPerHour,
			),
			await incrementGuestBucket(
				tx,
				"guest-upload-subnet-hour",
				input.subnetHash,
				hourStart,
				3_600_000,
				input.abuseLimits.maximumRequestsPerIpPerHour,
			),
			await incrementGuestBucket(
				tx,
				"guest-upload-global-minute",
				"global",
				minuteStart,
				60_000,
				input.abuseLimits.maximumGlobalQueueDepth,
			),
		];
		if (checks.some((allowed) => !allowed)) throw new Error("GUEST_UPLOAD_RATE_LIMITED");
	});
	return createMediaUploadSessionTransaction(
		{
			assetId: input.assetId,
			sessionId: input.sessionId,
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			kind: input.kind,
			objectKey: input.objectKey,
			stagingObjectKey: input.stagingObjectKey,
			mimeType: input.mimeType,
			expectedBytes: input.expectedBytes,
			tokenHash: input.completionTokenHash,
			expiresAt: input.expiresAt,
			multipartUploadId: input.multipartUploadId,
			limits: input.limits,
			guest: {
				capabilityVersion: input.capabilityVersion,
				originHash: input.originHash,
				expectedSha256: input.expectedSha256,
				deleteAfter: input.deleteAfter,
			},
		},
		client,
	);
}

export async function hasDurableGuestBootstrapProof(
	input: { claimHash: string; promotionPeriod: string; now?: Date },
	client: MediaTransactionClient,
): Promise<boolean> {
	const now = input.now ?? new Date();
	return Boolean(
		await client.guestSessionBootstrap.findFirst({
			where: {
				claimHash: input.claimHash,
				promotionPeriod: input.promotionPeriod,
				expiresAt: { gt: now },
				claimedDraft: { status: "ACTIVE", expiresAt: { gt: now } },
			},
			select: { id: true },
		}),
	);
}

export async function loadGuestUploadCompletion(
	input: {
		sessionId: string;
		completionTokenHash: string;
		capabilityVersion: string;
		originHash: string;
		expectedSha256: string;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<{
	ownerId: string;
	assetId: string;
	status: "PENDING" | "FINALIZING" | "COMPLETED";
	stagingObjectKey: string;
	contentType: string;
	expectedBytes: number;
	expectedSha256: string;
	capabilityVersion: string;
}> {
	const session = await client.mediaUploadSession.findFirst({
		where: {
			id: input.sessionId,
			tokenHash: input.completionTokenHash,
			guestCompletionConsumedAt: null,
			guestCapabilityVersion: input.capabilityVersion,
			guestOriginHash: input.originHash,
			guestExpectedSha256: input.expectedSha256,
			expiresAt: { gt: input.now ?? new Date() },
			status: { in: ["PENDING", "FINALIZING", "COMPLETED"] },
			asset: { retentionClass: "GUEST_TRIAL", deletedAt: null },
		},
		include: { asset: true },
	});
	if (
		!session ||
		!session.stagingObjectKey ||
		!session.guestCapabilityVersion ||
		!session.guestExpectedSha256 ||
		!Number.isSafeInteger(Number(session.expectedBytes))
	) {
		throw new Error("GUEST_UPLOAD_UNAVAILABLE");
	}
	return {
		ownerId: session.asset.ownerId,
		assetId: session.assetId,
		status: session.status as "PENDING" | "FINALIZING" | "COMPLETED",
		stagingObjectKey: session.stagingObjectKey,
		contentType: session.asset.mimeType,
		expectedBytes: Number(session.expectedBytes),
		expectedSha256: session.guestExpectedSha256,
		capabilityVersion: session.guestCapabilityVersion,
	};
}

export interface ConsumeGuestBootstrapInput {
	claimHash: string;
	expectedOrigin: string;
	origin: string | null;
	principalEmail: string;
	promotionPeriod: string;
	ipHash: string;
	subnetHash: string;
	limits: {
		maximumRequestsPerMinute: number;
		maximumRequestsPerIpPerHour: number;
		maximumGlobalQueueDepth: number;
	};
	now?: Date;
}

export type ConsumeGuestBootstrapResult<T> =
	| { outcome: "CREATED"; userId: string; value: T }
	| { outcome: "REPLAY"; userId: string };

type ConsumeTransactionResult<T> =
	| ConsumeGuestBootstrapResult<T>
	| { outcome: "ERROR"; error: unknown };

export async function consumeGuestBootstrap<T>(
	input: ConsumeGuestBootstrapInput,
	createPrincipal: (input: { email: string }) => Promise<{ userId: string; value: T }>,
	client: MediaTransactionClient,
): Promise<ConsumeGuestBootstrapResult<T>> {
	assertExactOrigin(input.origin, input.expectedOrigin);
	const transactionResult = await client.$transaction(
		async (tx): Promise<ConsumeTransactionResult<T>> => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.claimHash}, 0))`;
			const now = input.now ?? new Date();
			const bootstrap = await tx.guestSessionBootstrap.findFirst({
				where: {
					claimHash: input.claimHash,
					promotionPeriod: input.promotionPeriod,
					expiresAt: { gt: now },
					claimedDraft: { status: "ACTIVE", expiresAt: { gt: now } },
				},
				select: { id: true, ownerId: true, completedAt: true },
			});
			if (!bootstrap) return { outcome: "ERROR", error: new Error("GUEST_BOOTSTRAP_UNAVAILABLE") };
			if (bootstrap.ownerId && bootstrap.completedAt) {
				return { outcome: "REPLAY", userId: bootstrap.ownerId };
			}
			if (bootstrap.ownerId || bootstrap.completedAt) {
				return { outcome: "ERROR", error: new Error("GUEST_BOOTSTRAP_INVALID_STATE") };
			}

			try {
				await enforceGuestBootstrapCaps(input, now, tx);
				const principal = await createPrincipal({ email: input.principalEmail });
				const bound = await tx.guestSessionBootstrap.updateMany({
					where: { id: bootstrap.id, ownerId: null, completedAt: null, expiresAt: { gt: now } },
					data: { ownerId: principal.userId, completedAt: now },
				});
				if (bound.count !== 1) throw new Error("GUEST_BOOTSTRAP_BIND_FAILED");
				return { outcome: "CREATED", userId: principal.userId, value: principal.value };
			} catch (error) {
				return { outcome: "ERROR", error };
			}
		},
		// Better Auth commits the principal on its own connection while this
		// transaction holds the claim lock. PostgreSQL READ COMMITTED is required
		// so the owner foreign key can observe that commit; the advisory lock is
		// the serializing fence for every operation on this claim.
		{ maxWait: 10_000, timeout: 30_000 },
	);
	if (transactionResult.outcome === "ERROR") throw transactionResult.error;
	return transactionResult;
}

export async function cleanupUnboundGuestPrincipal(
	input: { claimHash: string; principalEmail: string },
	client: MediaTransactionClient,
): Promise<void> {
	await client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.claimHash}, 0))`;
		const bootstrap = await tx.guestSessionBootstrap.findUnique({
			where: { claimHash: input.claimHash },
			select: { ownerId: true },
		});
		if (!bootstrap?.ownerId) await deleteUnboundPrincipalByEmail(input.principalEmail, tx);
	});
}

async function deleteUnboundPrincipalByEmail(
	email: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	await tx.user.deleteMany({ where: { email, isAnonymous: true } });
}

async function enforceGuestBootstrapCaps(
	input: ConsumeGuestBootstrapInput,
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<void> {
	const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
	const hourStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
	const checks = [
		await incrementGuestBucket(
			tx,
			"guest-bootstrap-ip-minute",
			input.ipHash,
			minuteStart,
			60_000,
			input.limits.maximumRequestsPerMinute,
		),
		await incrementGuestBucket(
			tx,
			"guest-bootstrap-ip-hour",
			input.ipHash,
			hourStart,
			3_600_000,
			input.limits.maximumRequestsPerIpPerHour,
		),
		await incrementGuestBucket(
			tx,
			"guest-bootstrap-subnet-hour",
			input.subnetHash,
			hourStart,
			3_600_000,
			input.limits.maximumRequestsPerIpPerHour,
		),
		await incrementGuestBucket(
			tx,
			"guest-bootstrap-global-minute",
			"global",
			minuteStart,
			60_000,
			input.limits.maximumGlobalQueueDepth,
		),
	];
	if (checks.some((allowed) => !allowed)) throw new Error("GUEST_TEMPORARY_USER_CAP_EXCEEDED");
}

export async function incrementGuestBucket(
	tx: Prisma.TransactionClient,
	scope: string,
	subjectHash: string,
	windowStart: Date,
	windowMs: number,
	maximum: number,
): Promise<boolean> {
	const windowEnd = new Date(windowStart.getTime() + windowMs);
	const [result] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
		INSERT INTO "guest_abuse_bucket"
			("id", "scope", "subjectHash", "windowStart", "windowEnd", "requestCount", "rejectionCount", "expiresAt", "version", "updatedAt")
		VALUES
			(gen_random_uuid()::text, ${scope}, ${subjectHash}, ${windowStart}, ${windowEnd}, 1, 0, ${new Date(windowEnd.getTime() + 24 * 60 * 60_000)}, 0, now())
		ON CONFLICT ("scope", "subjectHash", "windowStart") DO UPDATE
		SET "requestCount" = "guest_abuse_bucket"."requestCount" + 1,
			"version" = "guest_abuse_bucket"."version" + 1,
			"updatedAt" = now()
		RETURNING ("requestCount" <= ${BigInt(maximum)}) AS "allowed"`;
	return result?.allowed === true;
}

function assertExactOrigin(actualValue: string | null, expectedValue: string): void {
	let actual: URL;
	let expected: URL;
	try {
		if (!actualValue) throw new Error("missing");
		actual = new URL(actualValue);
		expected = new URL(expectedValue);
	} catch {
		throw new Error("FORBIDDEN_ORIGIN");
	}
	if (actualValue !== actual.origin || actual.origin !== expected.origin) {
		throw new Error("FORBIDDEN_ORIGIN");
	}
}
