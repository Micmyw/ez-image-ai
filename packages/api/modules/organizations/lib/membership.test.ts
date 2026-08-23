import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getOrganizationMembership: vi.fn(),
}));

import { getOrganizationMembership } from "@repo/database";

import { verifyOrganizationBillingManagement, verifyOrganizationMembership } from "./membership";

describe("verifyOrganizationMembership", () => {
	it("returns null when membership does not exist", async () => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce(null);

		const result = await verifyOrganizationMembership("org-1", "user-1");

		expect(result).toBeNull();
		expect(getOrganizationMembership).toHaveBeenCalledWith("org-1", "user-1");
	});

	it("returns organization and role when membership exists", async () => {
		const mockMembership = {
			id: "membership-1",
			organizationId: "org-1",
			userId: "user-1",
			role: "owner",
			createdAt: new Date(),
			organization: {
				id: "org-1",
				name: "Test Org",
				slug: "test-org",
				logo: null,
				createdAt: new Date(),
				metadata: null,
				paymentsCustomerId: null,
			},
		};
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce(mockMembership);

		const result = await verifyOrganizationMembership("org-1", "user-1");

		expect(result).toEqual({
			organization: mockMembership.organization,
			role: mockMembership.role,
		});
	});

	it("returns only organization and role, not the full membership object", async () => {
		const mockMembership = {
			id: "membership-2",
			organizationId: "org-2",
			userId: "user-2",
			role: "member",
			createdAt: new Date(),
			organization: {
				id: "org-2",
				name: "Another Org",
				slug: "another-org",
				logo: null,
				createdAt: new Date(),
				metadata: null,
				paymentsCustomerId: null,
			},
			extraField: "should-not-be-returned",
		};
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce(mockMembership);

		const result = await verifyOrganizationMembership("org-2", "user-2");

		expect(result).toEqual({
			organization: mockMembership.organization,
			role: mockMembership.role,
		});
		expect(result).not.toHaveProperty("extraField");
	});
});

describe("verifyOrganizationBillingManagement", () => {
	it("allows organization owners", async () => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce({
			id: "membership-1",
			organizationId: "org-1",
			userId: "user-1",
			role: "owner",
			createdAt: new Date(),
			organization: {
				id: "org-1",
				name: "Test Org",
				slug: "test-org",
				logo: null,
				createdAt: new Date(),
				metadata: null,
				paymentsCustomerId: null,
			},
		});

		const result = await verifyOrganizationBillingManagement("org-1", "user-1");

		expect(result?.role).toBe("owner");
	});

	it.each(["admin", "member"])("rejects organization %s roles", async (role) => {
		vi.mocked(getOrganizationMembership).mockResolvedValueOnce({
			id: "membership-1",
			organizationId: "org-1",
			userId: "user-1",
			role,
			createdAt: new Date(),
			organization: {
				id: "org-1",
				name: "Test Org",
				slug: "test-org",
				logo: null,
				createdAt: new Date(),
				metadata: null,
				paymentsCustomerId: null,
			},
		});

		const result = await verifyOrganizationBillingManagement("org-1", "user-1");

		expect(result).toBeNull();
	});
});
