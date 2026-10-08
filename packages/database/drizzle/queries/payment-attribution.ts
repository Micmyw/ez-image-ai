import { db } from "../client";

export interface AdminPaymentAttributionInput {
	limit: number;
	reference?: string;
}

export async function listAdminPaymentAttribution({
	limit,
	reference,
}: AdminPaymentAttributionInput) {
	const take = Math.max(1, Math.min(20, Math.trunc(limit)));
	const [purchases, checkouts] = await Promise.all([
		db.query.purchase.findMany({
			where: reference ? (purchase, { eq }) => eq(purchase.id, reference) : undefined,
			orderBy: (purchase, { desc }) => [desc(purchase.createdAt), desc(purchase.id)],
			limit: take,
			columns: {
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
		db.query.paymentCheckoutIntent.findMany({
			where: reference ? (intent, { eq }) => eq(intent.id, reference) : undefined,
			orderBy: (intent, { desc }) => [desc(intent.createdAt), desc(intent.id)],
			limit: take,
			columns: {
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
