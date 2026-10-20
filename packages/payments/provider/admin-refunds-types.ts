import type { AdminRefundPayment, readAdminRefundRequest } from "@repo/database";

export type AdminRefundRequestRecord = Awaited<ReturnType<typeof readAdminRefundRequest>>;

export type AdminRefundObservation =
	| {
			status: "SUCCEEDED";
			providerRefundId: string;
			amountMicros: bigint;
			currency: string;
			occurredAt: Date;
	  }
	| {
			status: "PROCESSING" | "UNKNOWN" | "FAILED";
			providerRefundId?: string;
			error?: string;
	  };

export interface AdminRefundAdapter {
	name: string;
	verifyPayment(payment: AdminRefundPayment): Promise<void>;
	submit(
		payment: AdminRefundPayment,
		request: AdminRefundRequestRecord,
	): Promise<AdminRefundObservation>;
	inspect(
		payment: AdminRefundPayment,
		request: AdminRefundRequestRecord,
	): Promise<AdminRefundObservation>;
}

export function assertRefundObservation(
	observation: AdminRefundObservation,
	request: Pick<AdminRefundRequestRecord, "amountMicros" | "currency">,
) {
	if (observation.status !== "SUCCEEDED") return;
	if (
		!observation.providerRefundId ||
		observation.amountMicros !== request.amountMicros ||
		observation.currency !== request.currency ||
		!Number.isFinite(observation.occurredAt.getTime())
	)
		throw new Error("ADMIN_REFUND_RECEIPT_MISMATCH");
}
