import { conversionInputSchema } from "../admin-analytics/conversion-types";
import { executeAdminAnalyticsOperation } from "../admin-analytics/service";
import {
	adminAnalyticsOverviewInputSchema,
	adminAnalyticsFunnelInputSchema,
	adminAnalyticsReportInputSchema,
} from "../admin-analytics/types";
import { adminBillingInputSchemas, executeAdminBillingOperation } from "../admin-billing/service";
import {
	adminSupportInputSchemas,
	executeAdminSupportOperation,
} from "../support/admin-operations";
import { AdminGatewayError, type AdminOperation } from "./types";

export const adminOperations: AdminOperation[] = [
	{
		name: "analytics_conversion",
		description:
			"Read consented traffic and the customer registration cohort, generation failures and trusted paid conversions.",
		path: "/api/admin/analytics/conversion",
		inputSchema: conversionInputSchema,
		permission: "admin.analytics.read",
		method: "GET",
		readOnly: true,
		platformOnly: true,
		handler: (input, context) =>
			executeAdminAnalyticsOperation("analytics_conversion", input, context),
	},
	...(
		[
			[
				"analytics_overview",
				"Read current users, subscriptions, tickets and currency-separated income.",
				"/api/admin/analytics/overview",
				adminAnalyticsOverviewInputSchema,
			],
			[
				"analytics_funnel",
				"Read the registration cohort funnel by source; historical unknown and direct traffic remain separate.",
				"/api/admin/analytics/funnel",
				adminAnalyticsFunnelInputSchema,
			],
			[
				"analytics_report",
				"Read a bounded period report with refunds recognized by refund date.",
				"/api/admin/analytics/report",
				adminAnalyticsReportInputSchema,
			],
		] as const
	).map(
		([name, description, path, inputSchema]): AdminOperation => ({
			name,
			description,
			path,
			inputSchema,
			permission: "admin.analytics.read",
			method: "GET",
			readOnly: true,
			handler: (input, context) => executeAdminAnalyticsOperation(name, input, context),
		}),
	),
	...(
		[
			[
				"orders_list",
				"Read payments in the authorized account scope.",
				"admin.payments.read",
				"GET",
				"/api/admin/orders",
				true,
			],
			[
				"orders_refund",
				"Request an authorized full refund using the recorded provider. Existing credit debt and subscription rules apply.",
				"admin.payments.refund",
				"POST",
				"/api/admin/orders/refund",
				false,
			],
			[
				"orders_reconcile",
				"Reconcile an existing uncertain refund without issuing another refund.",
				"admin.payments.refund",
				"POST",
				"/api/admin/orders/reconcile",
				false,
			],
			[
				"credits_adjust",
				"Grant or deduct shared account credits with an immutable, idempotent ledger entry.",
				"admin.credits.write",
				"POST",
				"/api/admin/users/credits",
				false,
			],
		] as const
	).map(
		([name, description, permission, method, path, readOnly]): AdminOperation => ({
			name,
			description,
			permission,
			method,
			path,
			readOnly,
			inputSchema: adminBillingInputSchemas[name],
			handler: (input, context) => executeAdminBillingOperation(name, input, context),
		}),
	),
	...(
		[
			[
				"tickets_list",
				"List support tickets within the authorized scope.",
				"admin.tickets.read",
				"GET",
				"/api/admin/tickets",
				true,
			],
			[
				"tickets_get",
				"Read an authorized ticket and its conversation.",
				"admin.tickets.read",
				"GET",
				"/api/admin/tickets/detail",
				true,
			],
			[
				"tickets_reply",
				"Send an authorized support reply once. Read the conversation before replying.",
				"admin.tickets.write",
				"POST",
				"/api/admin/tickets/reply",
				false,
			],
			[
				"tickets_status",
				"Update a ticket status with an expected update timestamp.",
				"admin.tickets.write",
				"POST",
				"/api/admin/tickets/status",
				false,
			],
			[
				"notifications_get",
				"Read masked platform bot settings and delivery limitations.",
				"admin.notifications.read",
				"GET",
				"/api/admin/notifications/configuration",
				true,
			],
			[
				"notifications_update",
				"Update platform bot settings; masked secrets preserve current values.",
				"admin.notifications.write",
				"PATCH",
				"/api/admin/notifications/configuration",
				false,
			],
			[
				"notifications_test",
				"Send an explicitly authorized bot test to the configured receiver. Acceptance is not downstream completion.",
				"admin.notifications.test",
				"POST",
				"/api/admin/notifications/test",
				false,
			],
		] as const
	).map(
		([name, description, permission, method, path, readOnly]): AdminOperation => ({
			name,
			description,
			permission,
			method,
			path,
			readOnly,
			platformOnly: name.startsWith("notifications_"),
			inputSchema: adminSupportInputSchemas[name],
			handler: (input, context) => executeAdminSupportOperation(name, input, context),
		}),
	),
];

export function findAdminOperation(name: string, operations = adminOperations): AdminOperation {
	const operation = operations.find((candidate) => candidate.name === name);
	if (!operation) throw new AdminGatewayError("ADMIN_OPERATION_NOT_FOUND", 404);
	return operation;
}
