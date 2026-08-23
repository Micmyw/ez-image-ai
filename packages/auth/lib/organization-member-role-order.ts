import type { OrganizationMemberRole } from "../auth";

export const organizationMemberRoleOrder = [
	"member",
	"admin",
	"owner",
] as const satisfies readonly OrganizationMemberRole[];
