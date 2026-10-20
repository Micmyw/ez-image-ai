/** Exact capabilities. Better Auth's existing admin role is the human ceiling. */
export const ADMIN_PERMISSION_CODES = [
	"admin.analytics.read",
	"admin.payments.read",
	"admin.payments.refund",
	"admin.credits.write",
	"admin.tickets.read",
	"admin.tickets.write",
	"admin.notifications.read",
	"admin.notifications.write",
	"admin.notifications.test",
	"admin.audit.read",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSION_CODES)[number];

export function adminPermissionsForHumanRole(role: string | null | undefined): AdminPermission[] {
	return role === "admin" ? [...ADMIN_PERMISSION_CODES] : [];
}

export function isAdminPermission(value: string): value is AdminPermission {
	return (ADMIN_PERMISSION_CODES as readonly string[]).includes(value);
}
