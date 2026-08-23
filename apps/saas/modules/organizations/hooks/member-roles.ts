import type { OrganizationMemberRole } from "@repo/auth";
import { organizationMemberRoleOrder } from "@repo/auth/lib/organization-member-role-order";
import { useTranslations } from "next-intl";

export function useOrganizationMemberRoles() {
	const t = useTranslations();

	return Object.fromEntries(
		organizationMemberRoleOrder.map((role) => [role, t(`organizations.roles.${role}`)]),
	) as Record<OrganizationMemberRole, string>;
}

export function useOrganizationMemberRoleOptions() {
	const t = useTranslations();

	return organizationMemberRoleOrder.map((role) => ({
		value: role,
		label: t(`organizations.roles.${role}`),
	}));
}
