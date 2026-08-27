import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "../../generated/client";
import { cleanupUnboundGuestPrincipal, consumeGuestBootstrap } from "./guest-bootstrap";

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

	it("holds the claim lock through bind failure and removes the unbound principal during cleanup", async () => {
		const fixture = await createBootstrapFixture();
		let principalCreated!: () => void;
		const principalCreatedSignal = new Promise<void>((resolve) => {
			principalCreated = resolve;
		});
		let releasePrincipal!: () => void;
		const principalRelease = new Promise<void>((resolve) => {
			releasePrincipal = resolve;
		});
		const createdUserId = `guest_${randomUUID().replaceAll("-", "")}`;
		createdUserIds.push(createdUserId);
		const createPrincipal = vi.fn(async ({ email }: { email: string }) => {
			await principalClient.user.create({
				data: {
					id: createdUserId,
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
					userId: createdUserId,
					expiresAt: new Date(Date.now() + 60_000),
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			principalCreated();
			await principalRelease;
			return { userId: `missing_${randomUUID()}`, value: "unused" };
		});
		const consume = consumeGuestBootstrap(
			{
				claimHash: fixture.claimHash,
				expectedOrigin: "https://app.test",
				origin: "https://app.test",
				principalEmail: fixture.principalEmail,
				promotionPeriod: fixture.promotionPeriod,
				ipHash: "ip-hash-bind-failure",
				subnetHash: "subnet-hash-bind-failure",
				limits: {
					maximumRequestsPerMinute: 100,
					maximumRequestsPerIpPerHour: 100,
					maximumGlobalQueueDepth: 100,
				},
			},
			createPrincipal,
			client,
		);
		await principalCreatedSignal;
		let cleanupFinished = false;
		const cleanup = cleanupUnboundGuestPrincipal(
			{ claimHash: fixture.claimHash, principalEmail: fixture.principalEmail },
			client,
		).then(() => {
			cleanupFinished = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(cleanupFinished).toBe(false);

		releasePrincipal();
		await expect(consume).rejects.toThrow();
		await cleanup;
		expect(cleanupFinished).toBe(true);
		await expect(client.user.count({ where: { id: createdUserId } })).resolves.toBe(0);
		await expect(client.session.count({ where: { userId: createdUserId } })).resolves.toBe(0);
		await expect(
			client.guestSessionBootstrap.findUnique({
				where: { claimHash: fixture.claimHash },
				select: { ownerId: true, completedAt: true },
			}),
		).resolves.toEqual({ ownerId: null, completedAt: null });
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
	const draftId = randomUUID();
	const bootstrapId = randomUUID();
	const claimHash = randomUUID().replaceAll("-", "").padEnd(64, "0");
	const promotionPeriod = `integration-${randomUUID()}`;
	const principalEmail = `guest-${randomUUID()}@anonymous.invalid`;
	createdDraftIds.push(draftId);
	createdBootstrapIds.push(bootstrapId);
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
	await client.guestSessionBootstrap.create({
		data: {
			id: bootstrapId,
			ownerId: null,
			promotionPeriod,
			claimHash,
			idempotencyKey: `bootstrap:${bootstrapId}`,
			claimedDraftId: draftId,
			expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
		},
	});
	return { claimHash, principalEmail, promotionPeriod };
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
