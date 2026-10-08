import { db } from "../client";

export interface AdminPaymentAttributionInput {
	limit: number;
	reference?: string;
}

// Administrator authorization belongs to the API boundary. These reads select
// local references only: provider customer/payment IDs and URLs stay private.
export async function listAdminPaymentAttribution({
	limit,
	reference,
}: AdminPaymentAttributionInput) {
	const take = Math.max(1, Math.min(20, Math.trunc(limit)));
	const [purchases, checkouts] = await Promise.all([
		db.purchase.findMany({
			where: reference ? { id: reference } : undefined,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take,
			select: {
				id: true,
				userId: true,
				organizationId: true,
				type: true,
				productKind: true,
				provider: true,
				status: true,
				createdAt: true,
				attribution: true,
			},
		}),
		db.paymentCheckoutIntent.findMany({
			where: reference ? { id: reference } : undefined,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take,
			select: {
				id: true,
				ownerType: true,
				ownerId: true,
				productKind: true,
				provider: true,
				planKey: true,
				interval: true,
				status: true,
				createdAt: true,
				attribution: true,
			},
		}),
	]);
	return { purchases, checkouts };
}
