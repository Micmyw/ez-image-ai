import { createPurchasesHelper } from "@repo/payments/lib/helper";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

export const usePurchases = (organizationId?: string) => {
	const { data } = useQuery({
		...orpc.payments.listPurchases.queryOptions({
			input: {
				organizationId,
			},
		}),
		refetchInterval: (query) =>
			query.state.data?.some(
				(purchase) =>
					purchase.subscription?.refundTermination === "PENDING" ||
					purchase.subscription?.refundTermination === "RETRYING",
			)
				? 15_000
				: false,
	});

	const purchases = data ?? [];

	return { purchases, ...createPurchasesHelper(purchases) };
};

export const useUserPurchases = () => usePurchases();

export const useOrganizationPurchases = (organizationId: string) => usePurchases(organizationId);
