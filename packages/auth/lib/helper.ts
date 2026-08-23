import type { ActiveOrganization } from "../auth";

function getOrganizationRole(
	organization?: ActiveOrganization | null,
	user?: {
		id: string;
		role?: string | null;
	} | null,
) {
	return organization?.members.find((member) => member.userId === user?.id)?.role;
}

export function isOrganizationAdmin(
	organization?: ActiveOrganization | null,
	user?: {
		id: string;
		role?: string | null;
	} | null,
) {
	const userOrganizationRole = getOrganizationRole(organization, user);

	return ["owner", "admin"].includes(userOrganizationRole ?? "") || user?.role === "admin";
}

export function isOrganizationOwner(
	organization?: ActiveOrganization | null,
	user?: {
		id: string;
		role?: string | null;
	} | null,
) {
	return getOrganizationRole(organization, user) === "owner";
}
