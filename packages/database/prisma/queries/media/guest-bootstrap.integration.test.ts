import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	acquireGuestBootstrapPrincipalLease,
	bindGuestBootstrapPrincipalLease,
	cleanupGuestBootstrapPrincipalLease,
	consumeGuestBootstrap,
	createGuestSessionBootstrapWithClaimFence,
} from "./guest-bootstrap";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;

let client: PrismaClient;
let principalClient: PrismaClient;
const createdBootstrapIds: string[] = [];
const createdDraftIds: string[] = [];
const createdUserIds: string[] = [];

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
						limits: {
							maximumRequestsPerMinute: 100,
							maximumRequestsPerIpPerHour: 100,
							maximumGlobalQueueDepth: 100,
						},
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
					limits: {
						maximumRequestsPerMinute: 1,
						maximumRequestsPerIpPerHour: 1,
						maximumGlobalQueueDepth: 1,
					},
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
					limits: {
						maximumRequestsPerMinute: 1,
						maximumRequestsPerIpPerHour: 1,
						maximumGlobalQueueDepth: 1,
					},
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
						maximumRequestsPerMinute: 0,
						maximumRequestsPerIpPerHour: 1,
						maximumGlobalQueueDepth: 1,
					},
				},
				createPrincipal,
				client,
			),
		).rejects.toThrow("GUEST_TEMPORARY_USER_CAP_EXCEEDED");
		expect(createPrincipal).not.toHaveBeenCalled();
	});
});

async function createBootstrapFixture(overrides: { expiresAt?: Date } = {}) {
	const bootstrapId = randomUUID();
	const claimHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
	const promotionPeriod = `integration-${randomUUID()}`;
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
			},
			tx,
		),
	);
	return { claimHash, principalEmail, promotionPeriod };
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
		limits: {
			maximumRequestsPerMinute: 100,
			maximumRequestsPerIpPerHour: 100,
			maximumGlobalQueueDepth: 100,
		},
		...overrides,
	};
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
