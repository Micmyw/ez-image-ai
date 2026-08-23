import { getOrganizationMembership } from "@repo/database";

export async function verifyOrganizationMembership(organizationId: string, userId: string) {
	const membership = await getOrganizationMembership(organizationId, userId);

	if (!membership) {
		return null;
	}

	return {
		organization: membership.organization,
		role: membership.role,
	};
}

export async function verifyOrganizationBillingManagement(organizationId: string, userId: string) {
	const membership = await verifyOrganizationMembership(organizationId, userId);

	if (!membership || membership.role !== "owner") {
		return null;
	}

	return membership;
}
