import { call } from "@orpc/server";
import type { Session } from "@repo/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: vi.fn(),
		},
	},
}));

vi.mock("@repo/database", async () => {
	const { z } = await import("zod");

	return {
		PurchaseSchema: z.object({}),
		getOrganizationMembership: vi.fn(),
		getPurchasesByOrganizationId: vi.fn(),
		getPurchasesByUserId: vi.fn(),
	};
});

import { auth } from "@repo/auth";
import {
	getOrganizationMembership,
	getPurchasesByOrganizationId,
	getPurchasesByUserId,
} from "@repo/database";

import { listPurchases } from "./list-purchases";

const authenticatedSession = {
	session: {
		id: "session-1",
		createdAt: new Date(),
		updatedAt: new Date(),
		userId: "user-1",
		expiresAt: new Date(Date.now() + 60_000),
		token: "session-token",
		ipAddress: null,
		userAgent: null,
		impersonatedBy: null,
		activeOrganizationId: null,
	},
	user: {
		id: "user-1",
		name: "Test User",
		email: "test@example.com",
		emailVerified: true,
		image: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		role: "user",
		banned: null,
		banReason: null,
		banExpires: null,
		onboardingComplete: true,
		locale: null,
		twoFactorEnabled: false,
		lastActiveOrganizationId: null,
	},
} satisfies Session;

const organizationMembership = {
	id: "membership-1",
	organizationId: "organization-1",
	userId: "user-1",
	role: "member",
	createdAt: new Date(),
	organization: {
		id: "organization-1",
		name: "Test Organization",
		slug: "test-organization",
		logo: null,
		createdAt: new Date(),
		metadata: null,
		paymentsCustomerId: null,
	},
} satisfies NonNullable<Awaited<ReturnType<typeof getOrganizationMembership>>>;

describe("listPurchases", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
	});

	it("rejects access to purchases for an organization the user does not belong to", async () => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce(null);

		await expect(
			call(
				listPurchases,
				{ organizationId: "organization-2" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(getPurchasesByOrganizationId).not.toHaveBeenCalled();
	});

	it("allows organization members to list their organization's purchases", async () => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce(organizationMembership);
		vi.mocked(getPurchasesByOrganizationId).mockResolvedValueOnce([]);

		const result = await call(
			listPurchases,
			{ organizationId: "organization-1" },
			{ context: { headers: new Headers() } },
		);

		expect(result).toEqual([]);
		expect(getPurchasesByOrganizationId).toHaveBeenCalledWith("organization-1");
	});

	it("scopes personal purchases to the authenticated user", async () => {
		vi.mocked(getPurchasesByUserId).mockResolvedValueOnce([]);

		const result = await call(listPurchases, {}, { context: { headers: new Headers() } });

		expect(result).toEqual([]);
		expect(getPurchasesByUserId).toHaveBeenCalledWith("user-1");
		expect(getOrganizationMembership).not.toHaveBeenCalled();
	});
});
