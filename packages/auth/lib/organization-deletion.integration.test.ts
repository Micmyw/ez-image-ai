import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@repo/database/generated-client";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization, testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cancelOrganizationSubscriptionsBeforeDeletion } from "./organization-deletion";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function assertSafeTestDatabaseUrl() {
	if (!TEST_DATABASE_URL) {
		throw new Error("TEST_DATABASE_URL is required");
	}

	const parsed = new URL(TEST_DATABASE_URL);
	const safeDatabase =
		parsed.pathname === "/ai_media_foundation_test" ||
		/^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname);
	if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || !safeDatabase) {
		throw new Error(
			"TEST_DATABASE_URL must target 127.0.0.1:55432/ai_media_foundation_test or a dedicated ezpic_*_test database",
		);
	}

	if (process.env.DATABASE_URL === TEST_DATABASE_URL) {
		throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
	}

	return TEST_DATABASE_URL;
}

describe("Better Auth organization deletion boundary", () => {
	let client: PrismaClient;

	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: assertSafeTestDatabaseUrl() }),
		});
		await cleanFixtures(client);
	});

	afterAll(async () => {
		if (!client) {
			return;
		}

		await cleanFixtures(client);
		await client.$disconnect();
	});

	it.each([
		["non-member", undefined],
		["member", "member"],
		["admin", "admin"],
	] as const)("does not call Stripe or delete for a %s", async (_label, role) => {
		const fixture = await createFixture(client, role);
		const cancelSubscription = vi.fn();
		const testAuth = createTestAuth(client, cancelSubscription);
		const headers = await getAuthHeaders(testAuth, fixture.user.id);

		await expect(
			testAuth.api.deleteOrganization({
				body: { organizationId: fixture.organization.id },
				headers,
			}),
		).rejects.toMatchObject({ status: role ? "FORBIDDEN" : "BAD_REQUEST" });
		expect(cancelSubscription).not.toHaveBeenCalled();
		expect(
			await client.organization.findUnique({ where: { id: fixture.organization.id } }),
		).not.toBeNull();
	});

	it("allows an owner to cancel first and then delete", async () => {
		const fixture = await createFixture(client, "owner");
		const cancelSubscription = vi.fn().mockResolvedValue(undefined);
		const testAuth = createTestAuth(client, cancelSubscription);
		const headers = await getAuthHeaders(testAuth, fixture.user.id);

		await expect(
			testAuth.api.deleteOrganization({
				body: { organizationId: fixture.organization.id },
				headers,
			}),
		).resolves.toMatchObject({ id: fixture.organization.id });
		expect(cancelSubscription).toHaveBeenCalledWith(fixture.subscriptionId);
		expect(
			await client.organization.findUnique({ where: { id: fixture.organization.id } }),
		).toBeNull();
	});

	it("keeps the organization when Stripe fails and succeeds on retry", async () => {
		const fixture = await createFixture(client, "owner");
		const cancelSubscription = vi
			.fn()
			.mockRejectedValueOnce(new Error("Stripe temporarily unavailable"))
			.mockResolvedValueOnce(undefined);
		const testAuth = createTestAuth(client, cancelSubscription);
		const headers = await getAuthHeaders(testAuth, fixture.user.id);
		const request = () =>
			testAuth.api.deleteOrganization({
				body: { organizationId: fixture.organization.id },
				headers,
			});

		await expect(request()).rejects.toThrow("Stripe temporarily unavailable");
		expect(
			await client.organization.findUnique({ where: { id: fixture.organization.id } }),
		).not.toBeNull();
		await expect(request()).resolves.toMatchObject({ id: fixture.organization.id });
		expect(cancelSubscription).toHaveBeenCalledTimes(2);
		expect(
			await client.organization.findUnique({ where: { id: fixture.organization.id } }),
		).toBeNull();
	});
});

function createTestAuth(client: PrismaClient, cancelSubscription: (id: string) => Promise<void>) {
	return betterAuth({
		baseURL: "http://localhost:3000",
		secret: "organization-deletion-integration-secret-at-least-32-characters",
		database: prismaAdapter(client, { provider: "postgresql" }),
		plugins: [
			organization({
				organizationHooks: {
					beforeDeleteOrganization: ({ organization, user }) =>
						cancelOrganizationSubscriptionsBeforeDeletion(
							{ organizationId: organization.id, userId: user.id },
							{
								findMembership: (organizationId, userId) =>
									client.member.findUnique({
										where: { organizationId_userId: { organizationId, userId } },
									}),
								listPurchases: (organizationId) =>
									client.purchase.findMany({ where: { organizationId } }),
								cancelSubscription,
							},
						),
				},
			}),
			testUtils(),
		],
	});
}

async function getAuthHeaders(testAuth: ReturnType<typeof createTestAuth>, userId: string) {
	const context = await testAuth.$context;
	return context.test.getAuthHeaders({ userId });
}

async function createFixture(client: PrismaClient, role?: string) {
	const suffix = crypto.randomUUID();
	const user = await client.user.create({
		data: {
			id: `org-delete-user-${suffix}`,
			name: "Organization deletion fixture",
			email: `org-delete-${suffix}@example.test`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	const organization = await client.organization.create({
		data: {
			id: `org-delete-${suffix}`,
			name: "Organization deletion fixture",
			slug: `org-delete-${suffix}`,
			createdAt: new Date(),
		},
	});

	if (role) {
		await client.member.create({
			data: {
				id: `org-delete-member-${suffix}`,
				organizationId: organization.id,
				userId: user.id,
				role,
				createdAt: new Date(),
			},
		});
	}

	const subscriptionId = `sub_org_delete_${suffix}`;
	await client.purchase.create({
		data: {
			organizationId: organization.id,
			type: "SUBSCRIPTION",
			customerId: `cus_org_delete_${suffix}`,
			subscriptionId,
			priceId: `price_org_delete_${suffix}`,
			status: "active",
		},
	});

	return { user, organization, subscriptionId };
}

async function cleanFixtures(client: PrismaClient) {
	await client.organization.deleteMany({ where: { id: { startsWith: "org-delete-" } } });
	await client.user.deleteMany({ where: { id: { startsWith: "org-delete-user-" } } });
}
