import { randomUUID } from "node:crypto";

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
	client: MediaTransactionClient | Prisma.TransactionClient,
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

interface GuestBoundaryAbuseLimits {
	maximumRequestsPerIpPerTenMinutes: number;
	maximumRequestsPerIpPerDay: number;
	maximumRequestsPerSubnetPerDay: number;
	maximumGlobalRequestsPerMinute: number;
	maximumGlobalRequestsPerHour: number;
	maximumGlobalRequestsPerDay: number;
}

export interface CreateGuestMediaUploadIntentTransactionInput extends Omit<
	CreateMediaUploadSessionTransactionInput,
	"guest" | "tokenHash"
> {
	capabilityVersion: string;
	promotionPeriod: string;
	originHash: string;
	expectedSha256: string;
	deleteAfter: Date;
	ipHash: string;
	subnetHash: string;
	abuseLimits: GuestBoundaryAbuseLimits & {
		maximumRequestsPerMinute: number;
		maximumRequestsPerIpPerHour: number;
		maximumGlobalQueueDepth: number;
	};
	abuseEvidenceTtlMs?: number;
	completionTokenHash: string;
}

export async function createGuestMediaUploadIntentTransaction(
	input: CreateGuestMediaUploadIntentTransactionInput,
	client: MediaTransactionClient,
) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.promotionPeriod)) {
		throw new Error("GUEST_UPLOAD_CONFIGURATION_INVALID");
	}
	const now = new Date();
	await client.$transaction(async (tx) => {
		if (
			!(await enforceGuestBoundaryRateLimits(
				{
					scopePrefix: "guest-upload",
					promotionPeriod: input.promotionPeriod,
					ipHash: input.ipHash,
					subnetHash: input.subnetHash,
					limits: input.abuseLimits,
					now,
					evidenceTtlMs: input.abuseEvidenceTtlMs,
				},
				tx,
			))
		) {
			throw new Error("GUEST_UPLOAD_RATE_LIMITED");
		}
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

export interface CreateGuestSessionBootstrapInput {
	id?: string;
	promotionPeriod: string;
	claimHash: string;
	idempotencyKey: string;
	claimedDraftId: string;
	sourceAssetId?: string;
	expiresAt: Date;
	maximumOutstandingBootstraps: number;
	now?: Date;
}

export async function createGuestSessionBootstrapWithClaimFence(
	input: CreateGuestSessionBootstrapInput,
	tx: Prisma.TransactionClient,
) {
	if (
		!Number.isSafeInteger(input.maximumOutstandingBootstraps) ||
		input.maximumOutstandingBootstraps < 1
	) {
		throw new Error("GUEST_OUTSTANDING_BOOTSTRAP_CAP_INVALID");
	}
	await lockGuestBootstrapClaim(input.claimHash, tx);
	await lockGuestBootstrapGlobalCap(tx);
	const outstandingBootstraps = await tx.guestSessionBootstrap.count({
		where: {
			ownerId: null,
			completedAt: null,
			expiresAt: { gt: input.now ?? new Date() },
		},
	});
	if (outstandingBootstraps >= input.maximumOutstandingBootstraps) {
		throw new Error("GUEST_OUTSTANDING_BOOTSTRAP_CAP_EXCEEDED");
	}
	return tx.guestSessionBootstrap.create({
		data: {
			id: input.id,
			ownerId: null,
			promotionPeriod: input.promotionPeriod,
			claimHash: input.claimHash,
			idempotencyKey: input.idempotencyKey,
			claimedDraftId: input.claimedDraftId,
			sourceAssetId: input.sourceAssetId,
			expiresAt: input.expiresAt,
		},
		select: { id: true, expiresAt: true },
	});
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
	limits: GuestBoundaryAbuseLimits & {
		maximumRequestsPerMinute: number;
		maximumRequestsPerIpPerHour: number;
		maximumGlobalQueueDepth: number;
		maximumOutstandingBootstraps?: number;
		maximumTemporaryPrincipals?: number;
	};
	abuseEvidenceTtlMs?: number;
	now?: Date;
}

export type ConsumeGuestBootstrapResult<T> =
	| { outcome: "CREATED"; userId: string; value: T }
	| { outcome: "REPLAY"; userId: string };

export type AcquireGuestBootstrapPrincipalLeaseResult =
	| { outcome: "ACQUIRED"; leaseToken: string; leaseVersion: number }
	| { outcome: "REPLAY"; userId: string }
	| { outcome: "WAIT" };

export interface GuestBootstrapPrincipalLeaseOptions {
	leaseDurationMs?: number;
	waitTimeoutMs?: number;
	pollIntervalMs?: number;
	createLeaseToken?: () => string;
	wait?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_GUEST_PRINCIPAL_LEASE_DURATION_MS = 30_000;
const DEFAULT_GUEST_PRINCIPAL_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_GUEST_PRINCIPAL_POLL_INTERVAL_MS = 100;

export async function acquireGuestBootstrapPrincipalLease(
	input: ConsumeGuestBootstrapInput,
	client: MediaTransactionClient,
	options: GuestBootstrapPrincipalLeaseOptions = {},
): Promise<AcquireGuestBootstrapPrincipalLeaseResult> {
	assertExactOrigin(input.origin, input.expectedOrigin);
	return client.$transaction(
		async (tx): Promise<AcquireGuestBootstrapPrincipalLeaseResult> => {
			await lockGuestBootstrapClaim(input.claimHash, tx);
			const now = input.now ?? new Date();
			const bootstrap = await tx.guestSessionBootstrap.findFirst({
				where: {
					claimHash: input.claimHash,
					promotionPeriod: input.promotionPeriod,
					expiresAt: { gt: now },
					claimedDraft: { status: "ACTIVE", expiresAt: { gt: now } },
				},
				select: {
					id: true,
					ownerId: true,
					completedAt: true,
					principalLeaseToken: true,
					principalLeaseExpiresAt: true,
					version: true,
				},
			});
			if (!bootstrap) throw new Error("GUEST_BOOTSTRAP_UNAVAILABLE");
			if (bootstrap.ownerId && bootstrap.completedAt) {
				const replayed = await tx.guestSessionBootstrap.updateMany({
					where: {
						id: bootstrap.id,
						ownerId: bootstrap.ownerId,
						completedAt: bootstrap.completedAt,
						version: bootstrap.version,
					},
					data: { version: { increment: 1 } },
				});
				if (replayed.count !== 1) throw new Error("GUEST_BOOTSTRAP_REPLAY_RACE");
				return { outcome: "REPLAY", userId: bootstrap.ownerId };
			}
			if (bootstrap.ownerId || bootstrap.completedAt) {
				throw new Error("GUEST_BOOTSTRAP_INVALID_STATE");
			}
			if (Boolean(bootstrap.principalLeaseToken) !== Boolean(bootstrap.principalLeaseExpiresAt)) {
				throw new Error("GUEST_BOOTSTRAP_INVALID_STATE");
			}
			if (
				bootstrap.principalLeaseToken &&
				bootstrap.principalLeaseExpiresAt &&
				bootstrap.principalLeaseExpiresAt > now
			) {
				return { outcome: "WAIT" };
			}

			await enforceGuestBootstrapCaps(input, now, tx);
			const leaseToken = options.createLeaseToken?.() ?? randomUUID();
			const principalLeaseExpiresAt = new Date(
				now.getTime() + (options.leaseDurationMs ?? DEFAULT_GUEST_PRINCIPAL_LEASE_DURATION_MS),
			);
			const acquired = await tx.guestSessionBootstrap.updateMany({
				where: {
					id: bootstrap.id,
					ownerId: null,
					completedAt: null,
					version: bootstrap.version,
					...(bootstrap.principalLeaseToken
						? {
								principalLeaseToken: bootstrap.principalLeaseToken,
								principalLeaseExpiresAt: { lte: now },
							}
						: { principalLeaseToken: null, principalLeaseExpiresAt: null }),
				},
				data: {
					principalLeaseToken: leaseToken,
					principalLeaseExpiresAt,
					version: { increment: 1 },
				},
			});
			if (acquired.count !== 1) throw new Error("GUEST_BOOTSTRAP_LEASE_RACE");
			if (bootstrap.principalLeaseToken) {
				await deleteUnboundPrincipalByEmail(input.principalEmail, tx);
			}
			return {
				outcome: "ACQUIRED",
				leaseToken,
				leaseVersion: bootstrap.version + 1,
			};
		},
		{ maxWait: 10_000, timeout: 30_000 },
	);
}

export async function bindGuestBootstrapPrincipalLease(
	input: {
		claimHash: string;
		leaseToken: string;
		leaseVersion: number;
		userId: string;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<void> {
	await client.$transaction(async (tx) => {
		await lockGuestBootstrapClaim(input.claimHash, tx);
		const now = input.now ?? new Date();
		const bound = await tx.guestSessionBootstrap.updateMany({
			where: {
				claimHash: input.claimHash,
				ownerId: null,
				completedAt: null,
				principalLeaseToken: input.leaseToken,
				principalLeaseExpiresAt: { gt: now },
				version: input.leaseVersion,
				expiresAt: { gt: now },
			},
			data: {
				ownerId: input.userId,
				completedAt: now,
				principalLeaseToken: null,
				principalLeaseExpiresAt: null,
				version: { increment: 1 },
			},
		});
		if (bound.count !== 1) throw new Error("GUEST_BOOTSTRAP_LEASE_LOST");
	});
}

export async function cleanupGuestBootstrapPrincipalLease(
	input: {
		claimHash: string;
		leaseToken: string;
		leaseVersion: number;
		principalEmail: string;
	},
	client: MediaTransactionClient,
): Promise<void> {
	await client.$transaction(async (tx) => {
		await lockGuestBootstrapClaim(input.claimHash, tx);
		const released = await tx.guestSessionBootstrap.updateMany({
			where: {
				claimHash: input.claimHash,
				ownerId: null,
				completedAt: null,
				principalLeaseToken: input.leaseToken,
				version: input.leaseVersion,
			},
			data: {
				principalLeaseToken: null,
				principalLeaseExpiresAt: null,
				version: { increment: 1 },
			},
		});
		if (released.count !== 1) throw new Error("GUEST_BOOTSTRAP_LEASE_LOST");
		await deleteUnboundPrincipalByEmail(input.principalEmail, tx);
	});
}

export async function consumeGuestBootstrap<T>(
	input: ConsumeGuestBootstrapInput,
	createPrincipal: (input: { email: string }) => Promise<{ userId: string; value: T }>,
	client: MediaTransactionClient,
	options: GuestBootstrapPrincipalLeaseOptions = {},
): Promise<ConsumeGuestBootstrapResult<T>> {
	assertExactOrigin(input.origin, input.expectedOrigin);
	const wait = options.wait ?? delay;
	const startedAt = Date.now();
	let lease: Extract<AcquireGuestBootstrapPrincipalLeaseResult, { outcome: "ACQUIRED" }>;
	for (;;) {
		const acquired = await acquireGuestBootstrapPrincipalLease(input, client, options);
		if (acquired.outcome === "REPLAY") return acquired;
		if (acquired.outcome === "ACQUIRED") {
			lease = acquired;
			break;
		}
		const timeout = options.waitTimeoutMs ?? DEFAULT_GUEST_PRINCIPAL_WAIT_TIMEOUT_MS;
		if (Date.now() - startedAt >= timeout) throw new Error("GUEST_BOOTSTRAP_IN_PROGRESS");
		await wait(options.pollIntervalMs ?? DEFAULT_GUEST_PRINCIPAL_POLL_INTERVAL_MS);
	}

	try {
		const principal = await createPrincipal({ email: input.principalEmail });
		await bindGuestBootstrapPrincipalLease(
			{
				claimHash: input.claimHash,
				leaseToken: lease.leaseToken,
				leaseVersion: lease.leaseVersion,
				userId: principal.userId,
				...(input.now ? { now: input.now } : {}),
			},
			client,
		);
		return { outcome: "CREATED", userId: principal.userId, value: principal.value };
	} catch (error) {
		await cleanupGuestBootstrapPrincipalLease(
			{
				claimHash: input.claimHash,
				leaseToken: lease.leaseToken,
				leaseVersion: lease.leaseVersion,
				principalEmail: input.principalEmail,
			},
			client,
		);
		throw error;
	}
}

async function deleteUnboundPrincipalByEmail(
	email: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	await tx.user.deleteMany({ where: { email, isAnonymous: true } });
}

async function lockGuestBootstrapClaim(
	claimHash: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${claimHash}, 0))`;
}

async function lockGuestBootstrapGlobalCap(tx: Prisma.TransactionClient): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('guest-bootstrap-cap:global', 0))`;
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function enforceGuestBootstrapCaps(
	input: ConsumeGuestBootstrapInput,
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<void> {
	if (input.limits.maximumTemporaryPrincipals !== undefined) {
		await lockGuestBootstrapGlobalCap(tx);
		const [anonymousPrincipals, activePrincipalLeases] = await Promise.all([
			tx.user.count({ where: { isAnonymous: true } }),
			tx.guestSessionBootstrap.count({
				where: {
					ownerId: null,
					principalLeaseToken: { not: null },
					principalLeaseExpiresAt: { gt: now },
				},
			}),
		]);
		if (anonymousPrincipals + activePrincipalLeases >= input.limits.maximumTemporaryPrincipals) {
			throw new Error("GUEST_TEMPORARY_PRINCIPAL_CAP_EXCEEDED");
		}
	}
	if (
		!(await enforceGuestBoundaryRateLimits(
			{
				scopePrefix: "guest-bootstrap",
				promotionPeriod: input.promotionPeriod,
				ipHash: input.ipHash,
				subnetHash: input.subnetHash,
				limits: input.limits,
				now,
				evidenceTtlMs: input.abuseEvidenceTtlMs,
			},
			tx,
		))
	) {
		throw new Error("GUEST_TEMPORARY_USER_CAP_EXCEEDED");
	}
}

async function enforceGuestBoundaryRateLimits(
	input: {
		scopePrefix: "guest-upload" | "guest-bootstrap";
		promotionPeriod: string;
		ipHash: string;
		subnetHash: string;
		limits: GuestBoundaryAbuseLimits;
		now: Date;
		evidenceTtlMs?: number;
	},
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	const windows = [
		{
			scope: `${input.scopePrefix}:${input.promotionPeriod}:ip:ten-minute`,
			subjectHash: input.ipHash,
			windowMs: 10 * 60_000,
			maximum: input.limits.maximumRequestsPerIpPerTenMinutes,
		},
		{
			scope: `${input.scopePrefix}:${input.promotionPeriod}:ip:day`,
			subjectHash: input.ipHash,
			windowMs: 24 * 60 * 60_000,
			maximum: input.limits.maximumRequestsPerIpPerDay,
		},
		{
			scope: `${input.scopePrefix}:${input.promotionPeriod}:subnet:day`,
			subjectHash: input.subnetHash,
			windowMs: 24 * 60 * 60_000,
			maximum: input.limits.maximumRequestsPerSubnetPerDay,
		},
		{
			scope: `${input.scopePrefix}:global:minute`,
			subjectHash: "global",
			windowMs: 60_000,
			maximum: input.limits.maximumGlobalRequestsPerMinute,
		},
		{
			scope: `${input.scopePrefix}:global:hour`,
			subjectHash: "global",
			windowMs: 60 * 60_000,
			maximum: input.limits.maximumGlobalRequestsPerHour,
		},
		{
			scope: `${input.scopePrefix}:global:day`,
			subjectHash: "global",
			windowMs: 24 * 60 * 60_000,
			maximum: input.limits.maximumGlobalRequestsPerDay,
		},
	] as const;
	for (const window of windows) {
		const windowStart = new Date(
			Math.floor(input.now.getTime() / window.windowMs) * window.windowMs,
		);
		if (
			!(await incrementGuestBucket(
				tx,
				window.scope,
				window.subjectHash,
				windowStart,
				window.windowMs,
				window.maximum,
				input.evidenceTtlMs,
			))
		) {
			return false;
		}
	}
	return true;
}

export async function incrementGuestBucket(
	tx: Prisma.TransactionClient,
	scope: string,
	subjectHash: string,
	windowStart: Date,
	windowMs: number,
	maximum: number,
	evidenceTtlMs = 24 * 60 * 60_000,
): Promise<boolean> {
	const windowEnd = new Date(windowStart.getTime() + windowMs);
	const expiresAt = new Date(windowEnd.getTime() + evidenceTtlMs);
	const [result] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
		INSERT INTO "guest_abuse_bucket"
			("id", "scope", "subjectHash", "windowStart", "windowEnd", "requestCount", "rejectionCount", "expiresAt", "version", "updatedAt")
		VALUES
			(gen_random_uuid()::text, ${scope}, ${subjectHash}, ${windowStart}, ${windowEnd}, 1, 0, ${expiresAt}, 0, now())
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
