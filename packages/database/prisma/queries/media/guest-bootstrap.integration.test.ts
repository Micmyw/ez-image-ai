import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "../../generated/client";
import { finalizeGuestDraftFromReadyUploadTransaction } from "./drafts";
import {
	acquireGuestBootstrapPrincipalLease,
	bindGuestBootstrapPrincipalLease,
	cleanupGuestBootstrapPrincipalLease,
	consumeGuestBootstrap,
	createGuestMediaUploadIntentTransaction,
	createGuestSessionBootstrapWithClaimFence,
} from "./guest-bootstrap";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const TEST_MAXIMUM_OUTSTANDING_BOOTSTRAPS = Number.MAX_SAFE_INTEGER;

let client: PrismaClient;
let principalClient: PrismaClient;
const createdBootstrapIds: string[] = [];
const createdDraftIds: string[] = [];
const createdUserIds: string[] = [];

async function waitForDatabaseLockWaiters(expectedCount: number) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const [result] = await client.$queryRaw<Array<{ count: bigint }>>`
			SELECT COUNT(*)::bigint AS "count"
			FROM pg_stat_activity
			WHERE datname = current_database()
				AND pid <> pg_backend_pid()
				AND wait_event_type = 'Lock'
		`;
		if (Number(result?.count ?? 0n) >= expectedCount) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${expectedCount} database lock waiters`);
}

describe("guest bootstrap consumption", () => {
	beforeAll(() => {
		const connectionString = safeTestDatabaseUrl();
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
		principalClient = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
	});

	afterAll(async () => {
		if (createdBootstrapIds.length) {
			await client.guestSessionBootstrap.deleteMany({ where: { id: { in: createdBootstrapIds } } });
		}
		if (createdDraftIds.length) {
			await client.generationDraft.deleteMany({ where: { id: { in: createdDraftIds } } });
		}
		if (createdUserIds.length) {
			await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
		}
		await Promise.all([client?.$disconnect(), principalClient?.$disconnect()]);
	});

	it("creates one anonymous principal when the same bootstrap is claimed concurrently", async () => {
		const fixture = await createBootstrapFixture();
		const createPrincipal = vi.fn(async ({ email }: { email: string }) => {
			await new Promise((resolve) => setTimeout(resolve, 75));
			const userId = `guest_${randomUUID().replaceAll("-", "")}`;
			createdUserIds.push(userId);
			await principalClient.user.create({
				data: {
					id: userId,
					name: "Anonymous",
					email,
					emailVerified: false,
					isAnonymous: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			await principalClient.session.create({
				data: {
					id: randomUUID(),
					token: randomUUID(),
					userId,
					expiresAt: new Date(Date.now() + 60_000),
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			return { userId, value: userId };
		});

		const results = await Promise.all(
			Array.from({ length: 32 }, () =>
				consumeGuestBootstrap(
					{
						claimHash: fixture.claimHash,
						expectedOrigin: "https://app.test",
						origin: "https://app.test",
						principalEmail: fixture.principalEmail,
						promotionPeriod: fixture.promotionPeriod,
						ipHash: "ip-hash",
						subnetHash: "subnet-hash",
						limits: guestBoundaryLimits(),
					},
					createPrincipal,
					client,
				),
			),
		);

		expect(new Set(results.map((result) => result.userId)).size).toBe(1);
		expect(results.filter((result) => result.outcome === "CREATED")).toHaveLength(1);
		expect(results.filter((result) => result.outcome === "REPLAY")).toHaveLength(31);
		expect(createPrincipal).toHaveBeenCalledOnce();
		await expect(client.session.count({ where: { userId: results[0]!.userId } })).resolves.toBe(1);
		await expect(
			client.guestSessionBootstrap.findUnique({
				where: { claimHash: fixture.claimHash },
				select: { ownerId: true, completedAt: true },
			}),
		).resolves.toEqual({ ownerId: results[0]!.userId, completedAt: expect.any(Date) });
	});

	it("makes bootstrap creation wait for the same claim fence used by lease operations", async () => {
		const claimHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
		const promotionPeriod = `integration-${randomUUID()}`;
		const draftId = await createDraftFixture(claimHash);
		const bootstrapId = randomUUID();
		createdBootstrapIds.push(bootstrapId);
		let lockHeld!: () => void;
		const lockHeldSignal = new Promise<void>((resolve) => {
			lockHeld = resolve;
		});
		let releaseLock!: () => void;
		const lockRelease = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		const blocker = client.$transaction(async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${claimHash}, 0))`;
			lockHeld();
			await lockRelease;
		});
		await lockHeldSignal;
		let writerFinished = false;
		const writer = principalClient
			.$transaction((tx) =>
				createGuestSessionBootstrapWithClaimFence(
					{
						id: bootstrapId,
						promotionPeriod,
						claimHash,
						idempotencyKey: `bootstrap:${bootstrapId}`,
						claimedDraftId: draftId,
						expiresAt: new Date(Date.now() + 60_000),
						maximumOutstandingBootstraps: TEST_MAXIMUM_OUTSTANDING_BOOTSTRAPS,
					},
					tx,
				),
			)
			.then(() => {
				writerFinished = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(writerFinished).toBe(false);
		await expect(client.guestSessionBootstrap.count({ where: { claimHash } })).resolves.toBe(0);

		releaseLock();
		await Promise.all([blocker, writer]);
		expect(writerFinished).toBe(true);
	});

	it("recovers an orphan after cleanup failure and rejects the old owner's late bind after takeover", async () => {
		const fixture = await createBootstrapFixture();
		const leaseStartedAt = new Date();
		const firstLease = await acquireGuestBootstrapPrincipalLease(
			guestConsumeInput(fixture, { now: leaseStartedAt }),
			client,
			{ leaseDurationMs: 50 },
		);
		expect(firstLease.outcome).toBe("ACQUIRED");
		if (firstLease.outcome !== "ACQUIRED") throw new Error("expected acquired lease");

		const oldUserId = await createPrincipalFixture(fixture.principalEmail);
		await expect(
			bindGuestBootstrapPrincipalLease(
				{
					claimHash: fixture.claimHash,
					leaseToken: firstLease.leaseToken,
					leaseVersion: firstLease.leaseVersion,
					userId: `missing_${randomUUID()}`,
					now: new Date(leaseStartedAt.getTime() + 1),
				},
				client,
			),
		).rejects.toThrow();

		const unavailableCleanupClient = {
			$transaction: vi.fn().mockRejectedValue(new Error("simulated cleanup outage")),
		};
		await expect(
			cleanupGuestBootstrapPrincipalLease(
				{
					claimHash: fixture.claimHash,
					leaseToken: firstLease.leaseToken,
					leaseVersion: firstLease.leaseVersion,
					principalEmail: fixture.principalEmail,
				},
				unavailableCleanupClient as never,
			),
		).rejects.toThrow("simulated cleanup outage");
		await expect(client.user.count({ where: { id: oldUserId } })).resolves.toBe(1);

		const takeover = await acquireGuestBootstrapPrincipalLease(
			guestConsumeInput(fixture, { now: new Date(leaseStartedAt.getTime() + 51) }),
			client,
			{ leaseDurationMs: 1_000 },
		);
		expect(takeover.outcome).toBe("ACQUIRED");
		if (takeover.outcome !== "ACQUIRED") throw new Error("expected takeover lease");
		await expect(client.user.count({ where: { id: oldUserId } })).resolves.toBe(0);
		await expect(client.session.count({ where: { userId: oldUserId } })).resolves.toBe(0);

		await expect(
			bindGuestBootstrapPrincipalLease(
				{
					claimHash: fixture.claimHash,
					leaseToken: firstLease.leaseToken,
					leaseVersion: firstLease.leaseVersion,
					userId: oldUserId,
					now: new Date(leaseStartedAt.getTime() + 52),
				},
				client,
			),
		).rejects.toThrow("GUEST_BOOTSTRAP_LEASE_LOST");

		const replacementUserId = await createPrincipalFixture(fixture.principalEmail);
		await bindGuestBootstrapPrincipalLease(
			{
				claimHash: fixture.claimHash,
				leaseToken: takeover.leaseToken,
				leaseVersion: takeover.leaseVersion,
				userId: replacementUserId,
				now: new Date(leaseStartedAt.getTime() + 53),
			},
			client,
		);
		await expect(
			client.user.count({ where: { email: fixture.principalEmail, isAnonymous: true } }),
		).resolves.toBe(1);
		await expect(client.session.count({ where: { userId: replacementUserId } })).resolves.toBe(1);
		await expect(
			client.guestSessionBootstrap.findUnique({
				where: { claimHash: fixture.claimHash },
				select: {
					ownerId: true,
					completedAt: true,
					principalLeaseToken: true,
					principalLeaseExpiresAt: true,
				},
			}),
		).resolves.toEqual({
			ownerId: replacementUserId,
			completedAt: expect.any(Date),
			principalLeaseToken: null,
			principalLeaseExpiresAt: null,
		});
	});

	it("rejects origin, expiry, and caps before creating any principal", async () => {
		const createPrincipal = vi.fn();
		const originFixture = await createBootstrapFixture();

		await expect(
			consumeGuestBootstrap(
				{
					claimHash: originFixture.claimHash,
					expectedOrigin: "https://app.test",
					origin: "https://evil.test",
					principalEmail: originFixture.principalEmail,
					promotionPeriod: originFixture.promotionPeriod,
					ipHash: "ip-hash-expired",
					subnetHash: "subnet-hash-expired",
					limits: guestBoundaryLimits(1),
				},
				createPrincipal,
				client,
			),
		).rejects.toThrow("FORBIDDEN_ORIGIN");

		const expiryBoundary = new Date(Date.now() + 1_000);
		const expiredFixture = await createBootstrapFixture({ expiresAt: expiryBoundary });
		await expect(
			consumeGuestBootstrap(
				{
					claimHash: expiredFixture.claimHash,
					expectedOrigin: "https://app.test",
					origin: "https://app.test",
					principalEmail: expiredFixture.principalEmail,
					promotionPeriod: expiredFixture.promotionPeriod,
					ipHash: "ip-hash-expired",
					subnetHash: "subnet-hash-expired",
					limits: guestBoundaryLimits(1),
					now: new Date(expiryBoundary.getTime() + 1),
				},
				createPrincipal,
				client,
			),
		).rejects.toThrow("GUEST_BOOTSTRAP_UNAVAILABLE");

		const cappedFixture = await createBootstrapFixture();
		await expect(
			consumeGuestBootstrap(
				{
					claimHash: cappedFixture.claimHash,
					expectedOrigin: "https://app.test",
					origin: "https://app.test",
					principalEmail: cappedFixture.principalEmail,
					promotionPeriod: cappedFixture.promotionPeriod,
					ipHash: "ip-hash-capped",
					subnetHash: "subnet-hash-capped",
					limits: {
						...guestBoundaryLimits(1),
						maximumRequestsPerIpPerTenMinutes: 0,
					},
				},
				createPrincipal,
				client,
			),
		).rejects.toThrow("GUEST_TEMPORARY_USER_CAP_EXCEEDED");
		expect(createPrincipal).not.toHaveBeenCalled();
	});

	it("uses the explicit global admission limit instead of queue depth during bootstrap", async () => {
		const fixture = await createBootstrapFixture();
		const createPrincipal = vi.fn(async ({ email }: { email: string }) => {
			const userId = await createPrincipalFixture(email);
			return { userId, value: userId };
		});

		await expect(
			consumeGuestBootstrap(
				{
					...guestConsumeInput(fixture),
					limits: {
						...guestConsumeInput(fixture).limits,
						maximumGlobalQueueDepth: 100,
						maximumGlobalRequestsPerMinute: 0,
					},
				},
				createPrincipal,
				client,
			),
		).rejects.toThrow("GUEST_TEMPORARY_USER_CAP_EXCEEDED");
		expect(createPrincipal).not.toHaveBeenCalled();
	});

	it("enforces the total-temporary-principal cap before identity creation", async () => {
		const createPrincipal = vi.fn(async ({ email }: { email: string }) => {
			const userId = await createPrincipalFixture(email);
			return { userId, value: userId };
		});
		const existingUserId = await createPrincipalFixture(
			`existing-${randomUUID()}@anonymous.invalid`,
		);
		const principalTarget = await createBootstrapFixture();
		await expect(
			consumeGuestBootstrap(
				{
					...guestConsumeInput(principalTarget),
					limits: {
						...guestConsumeInput(principalTarget).limits,
						maximumOutstandingBootstraps: 100,
						maximumTemporaryPrincipals: 1,
					},
				},
				createPrincipal,
				client,
			),
		).rejects.toThrow("GUEST_TEMPORARY_PRINCIPAL_CAP_EXCEEDED");
		expect(existingUserId).toBeTruthy();
		expect(createPrincipal).not.toHaveBeenCalled();
	});

	it("isolates upload subject evidence by promotion while retaining boundary-global capacity", async () => {
		await client.guestAbuseBucket.deleteMany({ where: { scope: { startsWith: "guest-upload" } } });
		const sharedIpHash = `upload-ip-${randomUUID()}`;
		const sharedSubnetHash = `upload-subnet-${randomUUID()}`;
		const limits = {
			...guestBoundaryLimits(2),
			maximumRequestsPerIpPerTenMinutes: 1,
			maximumRequestsPerIpPerDay: 1,
			maximumRequestsPerSubnetPerDay: 1,
		};
		const first = guestUploadIntentInput(
			"promotion-a",
			"upload-promotion-a",
			sharedIpHash,
			sharedSubnetHash,
			limits,
		);
		const second = guestUploadIntentInput(
			"promotion-b",
			"upload-promotion-b",
			sharedIpHash,
			sharedSubnetHash,
			limits,
		);

		await expect(createGuestMediaUploadIntentTransaction(first, client)).resolves.toBeDefined();
		await expect(createGuestMediaUploadIntentTransaction(second, client)).resolves.toBeDefined();
		await expect(
			client.mediaUploadSession.count({
				where: { asset: { ownerId: { in: [first.ownerId, second.ownerId] } } },
			}),
		).resolves.toBe(2);
		const scopes = await client.guestAbuseBucket.findMany({
			where: { subjectHash: { in: [sharedIpHash, sharedSubnetHash, "global"] } },
			select: { scope: true, subjectHash: true, requestCount: true },
		});
		expect(scopes).toEqual(
			expect.arrayContaining([
				{
					scope: "guest-upload:upload-promotion-a:ip:ten-minute",
					subjectHash: sharedIpHash,
					requestCount: 1n,
				},
				{
					scope: "guest-upload:upload-promotion-b:ip:day",
					subjectHash: sharedIpHash,
					requestCount: 1n,
				},
				{
					scope: "guest-upload:upload-promotion-a:subnet:day",
					subjectHash: sharedSubnetHash,
					requestCount: 1n,
				},
				{
					scope: "guest-upload:global:minute",
					subjectHash: "global",
					requestCount: 2n,
				},
				{
					scope: "guest-upload:global:hour",
					subjectHash: "global",
					requestCount: 2n,
				},
				{
					scope: "guest-upload:global:day",
					subjectHash: "global",
					requestCount: 2n,
				},
			]),
		);
		await expect(
			client.guestAbuseBucket.findFirst({
				where: { scope: "guest-upload:global:minute", subjectHash: "global" },
				select: { requestCount: true },
			}),
		).resolves.toEqual({ requestCount: 2n });
	});

	it.each(["", "bad:scope", "x".repeat(65)])(
		"rejects invalid upload promotion scope %j before writing rows",
		async (promotionPeriod) => {
			const input = guestUploadIntentInput(
				"invalid-promotion",
				promotionPeriod,
				`invalid-upload-ip-${randomUUID()}`,
				`invalid-upload-subnet-${randomUUID()}`,
			);

			await expect(createGuestMediaUploadIntentTransaction(input, client)).rejects.toThrow(
				"GUEST_UPLOAD_CONFIGURATION_INVALID",
			);
			await expect(
				Promise.all([
					client.mediaAsset.count({ where: { ownerId: input.ownerId } }),
					client.guestAbuseBucket.count({ where: { subjectHash: input.ipHash } }),
				]),
			).resolves.toEqual([0, 0]);
		},
	);

	it("keeps upload global capacity cross-promotion and creates no rejected upload rows", async () => {
		await client.guestAbuseBucket.deleteMany({ where: { scope: { startsWith: "guest-upload" } } });
		const first = guestUploadIntentInput(
			"global-a",
			"upload-global-a",
			`upload-global-ip-a-${randomUUID()}`,
			`upload-global-subnet-a-${randomUUID()}`,
			{ ...guestBoundaryLimits(100), maximumGlobalRequestsPerMinute: 1 },
		);
		const rejected = guestUploadIntentInput(
			"global-b",
			"upload-global-b",
			`upload-global-ip-b-${randomUUID()}`,
			`upload-global-subnet-b-${randomUUID()}`,
			{ ...guestBoundaryLimits(100), maximumGlobalRequestsPerMinute: 1 },
		);

		await createGuestMediaUploadIntentTransaction(first, client);
		await expect(createGuestMediaUploadIntentTransaction(rejected, client)).rejects.toThrow(
			"GUEST_UPLOAD_RATE_LIMITED",
		);
		await expect(
			Promise.all([
				client.mediaAsset.count({ where: { ownerId: rejected.ownerId } }),
				client.mediaUploadSession.count({ where: { asset: { ownerId: rejected.ownerId } } }),
				client.storageUsageReservation.count({ where: { ownerId: rejected.ownerId } }),
				client.auditLog.count({ where: { actorUserId: rejected.ownerId } }),
			]),
		).resolves.toEqual([0, 0, 0, 0]);
		await expect(
			client.guestAbuseBucket.findFirst({
				where: { scope: "guest-upload:global:minute", subjectHash: "global" },
				select: { requestCount: true },
			}),
		).resolves.toEqual({ requestCount: 1n });
	});

	it("isolates bootstrap subject evidence by promotion while retaining boundary-global capacity", async () => {
		await client.guestAbuseBucket.deleteMany({
			where: { scope: { startsWith: "guest-bootstrap" } },
		});
		const sharedIpHash = `bootstrap-ip-${randomUUID()}`;
		const sharedSubnetHash = `bootstrap-subnet-${randomUUID()}`;
		const first = await createBootstrapFixture({ promotionPeriod: "bootstrap-promotion-a" });
		const second = await createBootstrapFixture({ promotionPeriod: "bootstrap-promotion-b" });
		const createPrincipal = async ({ email }: { email: string }) => {
			const userId = await createPrincipalFixture(email);
			return { userId, value: userId };
		};
		const limits = {
			...guestBoundaryLimits(2),
			maximumRequestsPerIpPerTenMinutes: 1,
			maximumRequestsPerIpPerDay: 1,
			maximumRequestsPerSubnetPerDay: 1,
		};

		await expect(
			consumeGuestBootstrap(
				{ ...guestConsumeInput(first), ipHash: sharedIpHash, subnetHash: sharedSubnetHash, limits },
				createPrincipal,
				client,
			),
		).resolves.toMatchObject({ outcome: "CREATED" });
		await expect(
			consumeGuestBootstrap(
				{
					...guestConsumeInput(second),
					ipHash: sharedIpHash,
					subnetHash: sharedSubnetHash,
					limits,
				},
				createPrincipal,
				client,
			),
		).resolves.toMatchObject({ outcome: "CREATED" });
		const scopes = await client.guestAbuseBucket.findMany({
			where: { subjectHash: { in: [sharedIpHash, sharedSubnetHash, "global"] } },
			select: { scope: true, subjectHash: true, requestCount: true },
		});
		expect(scopes).toEqual(
			expect.arrayContaining([
				{
					scope: "guest-bootstrap:bootstrap-promotion-a:ip:ten-minute",
					subjectHash: sharedIpHash,
					requestCount: 1n,
				},
				{
					scope: "guest-bootstrap:bootstrap-promotion-b:ip:day",
					subjectHash: sharedIpHash,
					requestCount: 1n,
				},
				{
					scope: "guest-bootstrap:bootstrap-promotion-a:subnet:day",
					subjectHash: sharedSubnetHash,
					requestCount: 1n,
				},
				{
					scope: "guest-bootstrap:global:minute",
					subjectHash: "global",
					requestCount: 2n,
				},
				{
					scope: "guest-bootstrap:global:hour",
					subjectHash: "global",
					requestCount: 2n,
				},
				{
					scope: "guest-bootstrap:global:day",
					subjectHash: "global",
					requestCount: 2n,
				},
			]),
		);
		await expect(
			client.guestAbuseBucket.findFirst({
				where: { scope: "guest-bootstrap:global:minute", subjectHash: "global" },
				select: { requestCount: true },
			}),
		).resolves.toEqual({ requestCount: 2n });
	});

	it("keeps bootstrap global capacity cross-promotion", async () => {
		await client.guestAbuseBucket.deleteMany({
			where: { scope: { startsWith: "guest-bootstrap" } },
		});
		const first = await createBootstrapFixture({ promotionPeriod: "bootstrap-global-a" });
		const rejected = await createBootstrapFixture({ promotionPeriod: "bootstrap-global-b" });
		const createPrincipal = async ({ email }: { email: string }) => {
			const userId = await createPrincipalFixture(email);
			return { userId, value: userId };
		};
		const limits = { ...guestBoundaryLimits(100), maximumGlobalRequestsPerMinute: 1 };

		await consumeGuestBootstrap({ ...guestConsumeInput(first), limits }, createPrincipal, client);
		await expect(
			consumeGuestBootstrap({ ...guestConsumeInput(rejected), limits }, createPrincipal, client),
		).rejects.toThrow("GUEST_TEMPORARY_USER_CAP_EXCEEDED");
		await expect(
			client.guestAbuseBucket.findFirst({
				where: { scope: "guest-bootstrap:global:minute", subjectHash: "global" },
				select: { requestCount: true },
			}),
		).resolves.toEqual({ requestCount: 1n });
	});

	it("serializes the total temporary-principal cap across promotions", async () => {
		await client.guestAbuseBucket.deleteMany({
			where: { scope: { startsWith: "guest-bootstrap" } },
		});
		const now = new Date();
		const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
		const minuteEnd = new Date(minuteStart.getTime() + 60_000);
		const blockingScopes = ["guest-bootstrap-global-minute", "guest-bootstrap:global:minute"];
		await client.guestAbuseBucket.createMany({
			data: blockingScopes.map((scope) => ({
				scope,
				subjectHash: "global",
				windowStart: minuteStart,
				windowEnd: minuteEnd,
				expiresAt: new Date(minuteEnd.getTime() + 30 * 24 * 60 * 60_000),
			})),
		});
		const first = await createBootstrapFixture({ promotionPeriod: "principal-cap-a" });
		const second = await createBootstrapFixture({ promotionPeriod: "principal-cap-b" });
		const existingPrincipals = await client.user.count({ where: { isAnonymous: true } });
		const maximumTemporaryPrincipals = existingPrincipals + 1;
		const limits = {
			...guestBoundaryLimits(100),
			maximumOutstandingBootstraps: 100,
			maximumTemporaryPrincipals,
		};
		let markRowsLocked!: () => void;
		const rowsLocked = new Promise<void>((resolve) => {
			markRowsLocked = resolve;
		});
		let releaseRows!: () => void;
		const rowsReleased = new Promise<void>((resolve) => {
			releaseRows = resolve;
		});
		const blocker = principalClient.$transaction(async (tx) => {
			for (const scope of blockingScopes) {
				await tx.$queryRaw`SELECT "id" FROM "guest_abuse_bucket" WHERE "scope" = ${scope} AND "subjectHash" = 'global' AND "windowStart" = ${minuteStart} FOR UPDATE`;
			}
			markRowsLocked();
			await rowsReleased;
		});
		await rowsLocked;
		const resultsPromise = Promise.allSettled([
			acquireGuestBootstrapPrincipalLease({ ...guestConsumeInput(first), limits, now }, client, {
				leaseDurationMs: 60_000,
			}),
			acquireGuestBootstrapPrincipalLease({ ...guestConsumeInput(second), limits, now }, client, {
				leaseDurationMs: 60_000,
			}),
		]);
		await waitForDatabaseLockWaiters(2);
		releaseRows();
		const results = await resultsPromise;
		await blocker;

		for (const [index, result] of results.entries()) {
			if (result.status === "fulfilled" && result.value.outcome === "ACQUIRED") {
				const fixture = index === 0 ? first : second;
				await cleanupGuestBootstrapPrincipalLease(
					{
						claimHash: fixture.claimHash,
						leaseToken: result.value.leaseToken,
						leaseVersion: result.value.leaseVersion,
						principalEmail: fixture.principalEmail,
					},
					client,
				);
			}
		}
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const denied = results.find((result) => result.status === "rejected");
		expect(denied).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ message: "GUEST_TEMPORARY_PRINCIPAL_CAP_EXCEEDED" }),
		});
	});

	it("serializes outstanding bootstrap creation across promotions without partial loser writes", async () => {
		const now = new Date();
		const outstandingBefore = await countOutstandingBootstraps(now);
		await createBootstrapFixture({ promotionPeriod: "bootstrap-cap-preseed" });
		const maximumOutstandingBootstraps = outstandingBefore + 2;
		await expect(countOutstandingBootstraps(now)).resolves.toBe(maximumOutstandingBootstraps - 1);
		const fixtures = await Promise.all([
			createReadyGuestUploadFixture("bootstrap-cap-promotion-a"),
			createReadyGuestUploadFixture("bootstrap-cap-promotion-b"),
		]);
		const attempts = fixtures.map((fixture, index) => {
			const claimTokenHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
			const consumedTokenHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
			return {
				fixture,
				claimTokenHash,
				consumedTokenHash,
				run: () =>
					finalizeGuestDraftFromReadyUploadTransaction(
						{
							sessionId: fixture.sessionId,
							completionTokenHash: fixture.completionTokenHash,
							consumedTokenHash,
							claimTokenHash,
							capabilityVersion: fixture.capabilityVersion,
							promotionPeriod: fixture.promotionPeriod,
							maximumOutstandingBootstraps,
							prompt: `Concurrent cap contender ${index}`,
							expiresAt: new Date(fixture.now.getTime() + 30 * 60_000),
							verification: fixture.verification,
						},
						client,
					),
			};
		});

		const results = await concurrentSettledBarrier(attempts.map((attempt) => attempt.run));

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const loserIndex = results.findIndex((result) => result.status === "rejected");
		expect(results[loserIndex]).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ message: "GUEST_OUTSTANDING_BOOTSTRAP_CAP_EXCEEDED" }),
		});
		const loser = attempts[loserIndex]!;
		await expect(
			Promise.all([
				client.generationDraft.count({ where: { claimTokenHash: loser.claimTokenHash } }),
				client.guestSessionBootstrap.count({ where: { claimHash: loser.claimTokenHash } }),
				client.mediaUploadSession.findUniqueOrThrow({
					where: { id: loser.fixture.sessionId },
					select: { tokenHash: true, guestCompletionConsumedAt: true },
				}),
			]),
		).resolves.toEqual([
			0,
			0,
			{ tokenHash: loser.fixture.completionTokenHash, guestCompletionConsumedAt: null },
		]);
		await expect(countOutstandingBootstraps(now)).resolves.toBe(maximumOutstandingBootstraps);
	});

	it("allows a claim to drain an already over-cap outstanding bootstrap backlog", async () => {
		const blocker = await createBootstrapFixture({ promotionPeriod: "bootstrap-drain-blocker" });
		const target = await createBootstrapFixture({ promotionPeriod: "bootstrap-drain-target" });
		const now = new Date();
		const outstandingBefore = await countOutstandingBootstraps(now);
		const maximumOutstandingBootstraps = outstandingBefore - 1;
		const createPrincipal = vi.fn(async ({ email }: { email: string }) => {
			const userId = await createPrincipalFixture(email);
			return { userId, value: userId };
		});

		await expect(
			consumeGuestBootstrap(
				{
					...guestConsumeInput(target),
					limits: {
						...guestBoundaryLimits(100),
						maximumOutstandingBootstraps,
					},
					now,
				},
				createPrincipal,
				client,
			),
		).resolves.toMatchObject({ outcome: "CREATED" });
		expect(blocker.bootstrapId).toBeTruthy();
		expect(createPrincipal).toHaveBeenCalledOnce();
		await expect(countOutstandingBootstraps(now)).resolves.toBe(outstandingBefore - 1);
	});
});

async function createBootstrapFixture(
	overrides: { expiresAt?: Date; promotionPeriod?: string } = {},
) {
	const bootstrapId = randomUUID();
	const claimHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
	const promotionPeriod = overrides.promotionPeriod ?? `integration-${randomUUID()}`;
	const principalEmail = `guest-${randomUUID()}@anonymous.invalid`;
	createdBootstrapIds.push(bootstrapId);
	const draftId = await createDraftFixture(claimHash);
	await client.$transaction((tx) =>
		createGuestSessionBootstrapWithClaimFence(
			{
				id: bootstrapId,
				promotionPeriod,
				claimHash,
				idempotencyKey: `bootstrap:${bootstrapId}`,
				claimedDraftId: draftId,
				expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
				maximumOutstandingBootstraps: TEST_MAXIMUM_OUTSTANDING_BOOTSTRAPS,
			},
			tx,
		),
	);
	return { bootstrapId, claimHash, principalEmail, promotionPeriod };
}

async function createDraftFixture(claimHash: string): Promise<string> {
	const draftId = randomUUID();
	createdDraftIds.push(draftId);
	await client.generationDraft.create({
		data: {
			id: draftId,
			ownerType: "USER",
			ownerId: `draft_${randomUUID().replaceAll("-", "")}`,
			submittedByUserId: "guest-bootstrap",
			claimTokenHash: claimHash,
			productKey: "image-fast",
			inputSnapshot: { kind: "image-to-image", prompt: "Test" },
			expiresAt: new Date(Date.now() + 60_000),
		},
	});
	return draftId;
}

function guestConsumeInput(
	fixture: { claimHash: string; principalEmail: string; promotionPeriod: string },
	overrides: { now?: Date } = {},
) {
	return {
		claimHash: fixture.claimHash,
		expectedOrigin: "https://app.test",
		origin: "https://app.test",
		principalEmail: fixture.principalEmail,
		promotionPeriod: fixture.promotionPeriod,
		ipHash: `ip-${randomUUID()}`,
		subnetHash: `subnet-${randomUUID()}`,
		limits: guestBoundaryLimits(),
		...overrides,
	};
}

function guestBoundaryLimits(maximum = 100) {
	return {
		maximumRequestsPerMinute: maximum,
		maximumRequestsPerIpPerHour: maximum,
		maximumGlobalQueueDepth: maximum,
		maximumOutstandingBootstraps: 100,
		maximumTemporaryPrincipals: 100,
		maximumRequestsPerIpPerTenMinutes: maximum,
		maximumRequestsPerIpPerDay: maximum,
		maximumRequestsPerSubnetPerDay: maximum,
		maximumGlobalRequestsPerMinute: maximum,
		maximumGlobalRequestsPerHour: maximum,
		maximumGlobalRequestsPerDay: maximum,
	};
}

function guestUploadIntentInput(
	label: string,
	promotionPeriod: string,
	ipHash: string,
	subnetHash: string,
	abuseLimits = guestBoundaryLimits(),
) {
	const suffix = `${label}-${randomUUID()}`;
	const now = new Date();
	return {
		assetId: `asset-${suffix}`,
		sessionId: `session-${suffix}`,
		ownerType: "USER" as const,
		ownerId: `guest-${suffix}`,
		kind: "INPUT" as const,
		objectKey: `users/guest-${suffix}/assets/asset-${suffix}/original.png`,
		stagingObjectKey: `users/guest-${suffix}/staging/session-${suffix}/upload.png`,
		mimeType: "image/png",
		expectedBytes: 8n,
		completionTokenHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
		expiresAt: new Date(now.getTime() + 10 * 60_000),
		multipartUploadId: null,
		limits: { maximumActiveSessions: 1, maximumReservedBytes: 10n * 1024n * 1024n },
		capabilityVersion: "guest-v17",
		promotionPeriod,
		originHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
		expectedSha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
		deleteAfter: new Date(now.getTime() + 24 * 60 * 60_000),
		ipHash,
		subnetHash,
		abuseLimits,
		abuseEvidenceTtlMs: 30 * 24 * 60 * 60_000,
	};
}

async function createReadyGuestUploadFixture(promotionPeriod: string) {
	const input = guestUploadIntentInput(
		`ready-${promotionPeriod}`,
		promotionPeriod,
		`ready-ip-${randomUUID()}`,
		`ready-subnet-${randomUUID()}`,
	);
	await createGuestMediaUploadIntentTransaction(input, client);
	const now = new Date();
	const validUntil = new Date(now.getTime() + 60 * 60_000);
	const verification = {
		provider: "test",
		ruleVersion: "media-safety-rule-v1",
		policyVersion: "media-safety-policy-v1",
		now,
	};
	const providerTaskId = `moderation-${randomUUID()}`;
	await client.mediaAsset.update({
		where: { id: input.assetId },
		data: {
			status: "VERIFYING",
			checksum: input.expectedSha256,
			finalizedAt: now,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: verification.provider,
			verificationProviderTaskId: providerTaskId,
			verificationRuleVersion: verification.ruleVersion,
			verificationPolicyVersion: verification.policyVersion,
			verificationValidUntil: validUntil,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: input.assetId,
			assetChecksum: input.expectedSha256,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: verification.provider,
			providerTaskId,
			ruleVersion: verification.ruleVersion,
			policyVersion: verification.policyVersion,
			status: "APPROVED",
			reasonCode: "ALLOW",
			categories: {},
			rawEnvelope: {},
			validUntil,
			createdAt: now,
		},
	});
	await client.mediaAsset.update({
		where: { id: input.assetId },
		data: { status: "READY" },
	});
	await client.mediaUploadSession.update({
		where: { id: input.sessionId },
		data: {
			status: "COMPLETED",
			completedAt: now,
			stagedTerminalizationToken: null,
		},
	});
	return {
		assetId: input.assetId,
		sessionId: input.sessionId,
		completionTokenHash: input.completionTokenHash,
		capabilityVersion: input.capabilityVersion,
		promotionPeriod,
		now,
		verification,
	};
}

async function countOutstandingBootstraps(now: Date) {
	return client.guestSessionBootstrap.count({
		where: { ownerId: null, completedAt: null, expiresAt: { gt: now } },
	});
}

async function concurrentSettledBarrier<T>(operations: Array<() => Promise<T>>) {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const contenders = operations.map(async (operation) => {
		await gate;
		return operation();
	});
	release();
	return Promise.allSettled(contenders);
}

async function createPrincipalFixture(email: string): Promise<string> {
	const userId = `guest_${randomUUID().replaceAll("-", "")}`;
	createdUserIds.push(userId);
	await principalClient.user.create({
		data: {
			id: userId,
			name: "Anonymous",
			email,
			emailVerified: false,
			isAnonymous: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	await principalClient.session.create({
		data: {
			id: randomUUID(),
			token: randomUUID(),
			userId,
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	return userId;
}

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	if (DATABASE_URL && TEST_DATABASE_URL === DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(databaseName)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable loopback test database");
	}
	return TEST_DATABASE_URL;
}
