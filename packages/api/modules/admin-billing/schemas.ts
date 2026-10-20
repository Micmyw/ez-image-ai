import { z } from "zod";

export const adminBillingInputSchemas = {
	orders_list: z
		.object({
			limit: z.number().int().min(1).max(100).default(30),
			cursor: z.string().max(500).optional(),
			reference: z.string().trim().min(1).max(200).optional(),
		})
		.strict(),
	orders_refund: z
		.object({
			orderNo: z.string().min(1).max(200),
			reason: z.string().trim().max(500).optional(),
			cancelSubscription: z.boolean().default(false),
		})
		.strict(),
	orders_reconcile: z.object({ requestId: z.string().min(1).max(200) }).strict(),
	credits_adjust: z
		.object({
			ownerType: z.enum(["USER", "ORGANIZATION"]),
			ownerId: z.string().min(1).max(200),
			action: z.enum(["grant", "deduct"]),
			credits: z.number().int().min(1).max(1_000_000_000),
			reason: z.string().trim().min(1).max(500),
		})
		.strict(),
};

export type AdminBillingOperation = keyof typeof adminBillingInputSchemas;

export interface AdminBillingOrder {
	orderNo: string;
	productKind: string;
	ownerType: string;
	ownerId: string;
	provider: string;
	amountMicros: string | null;
	currency: string | null;
	paidAt: string | null;
	refundedAmountMicros: string | null;
	remainingAmountMicros: string | null;
	refundRequestId: string | null;
	refundStatus: string | null;
	canRefund: boolean;
	blockedReason: string | null;
	cancellationPolicyRequired: boolean;
	hasSubscription: boolean;
	canCancelSubscription: boolean;
}

export interface AdminBillingOrdersResult {
	items: AdminBillingOrder[];
	nextCursor: string | null;
}

export interface AdminBillingRefundResult {
	orderNo: string;
	requestId: string;
	status: "PROCESSING" | "UNKNOWN" | "SUCCEEDED" | "FAILED";
	amountMicros: string;
	currency: string;
	credits: { requested: string; revoked: string; debtIncurred: string };
	cancellation: {
		policyRequired: boolean;
		status: "NOT_REQUESTED" | "PENDING" | "SUCCEEDED" | "FAILED";
		error: string | null;
	};
	error: string | null;
}
