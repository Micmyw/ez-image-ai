import { isOrganizationAdmin, isOrganizationOwner } from "@repo/auth/lib/helper";
import { describe, expect, it } from "vitest";

const organization = {
	id: "org-1",
	members: [
		{ userId: "owner-user", role: "owner" },
		{ userId: "admin-user", role: "admin" },
		{ userId: "member-user", role: "member" },
	],
} as Parameters<typeof isOrganizationOwner>[0];

describe("organization role helpers", () => {
	it("returns true for owners", () => {
		expect(isOrganizationOwner(organization, { id: "owner-user" })).toBe(true);
	});

	it("returns false for organization admins who are not owners", () => {
		expect(isOrganizationOwner(organization, { id: "admin-user" })).toBe(false);
		expect(isOrganizationAdmin(organization, { id: "admin-user" })).toBe(true);
	});

	it("returns false for regular members", () => {
		expect(isOrganizationOwner(organization, { id: "member-user" })).toBe(false);
		expect(isOrganizationAdmin(organization, { id: "member-user" })).toBe(false);
	});

	it("returns false for global admins who are not organization owners", () => {
		expect(
			isOrganizationOwner(organization, {
				id: "outside-admin",
				role: "admin",
			}),
		).toBe(false);
		expect(
			isOrganizationAdmin(organization, {
				id: "outside-admin",
				role: "admin",
			}),
		).toBe(true);
	});
});
