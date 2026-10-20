import { adjustAdminCredits, listAdminRefundablePayments, type AdminScope } from "@repo/database";
import { reconcileAdminRefund, refundAdminOrder } from "@repo/payments";

import { adminBillingInputSchemas, type AdminBillingOperation } from "./schemas";

export { adminBillingInputSchemas } from "./schemas";

export interface AdminBillingContext {
	scope: AdminScope;
	actorId: string;
	idempotencyKey?: string;
	executionId?: string;
}

/** Authenticated gateways supply the scope; input cannot widen it. */
export async function executeAdminBillingOperation(
	operation: AdminBillingOperation,
	input: unknown,
	context: AdminBillingContext,
) {
	if (operation === "orders_list")
		return listAdminRefundablePayments(
			context.scope,
			adminBillingInputSchemas.orders_list.parse(input),
		);
	if (operation === "orders_refund")
		return refundAdminOrder({
			...adminBillingInputSchemas.orders_refund.parse(input),
			scope: context.scope,
			actorId: context.actorId,
		});
	if (operation === "orders_reconcile")
		return reconcileAdminRefund({
			...adminBillingInputSchemas.orders_reconcile.parse(input),
			scope: context.scope,
			actorId: context.actorId,
		});
	if (operation === "credits_adjust") {
		const idempotencyKey = context.executionId ?? context.idempotencyKey;
		if (!idempotencyKey) throw new Error("ADMIN_IDEMPOTENCY_KEY_REQUIRED");
		return adjustAdminCredits({
			...adminBillingInputSchemas.credits_adjust.parse(input),
			scope: context.scope,
			actorId: context.actorId,
			idempotencyKey,
		});
	}
	throw new Error("ADMIN_OPERATION_UNSUPPORTED");
}
