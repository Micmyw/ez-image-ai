import { orpcClient } from "@shared/lib/orpc-client";
import { queryOptions } from "@tanstack/react-query";

export function imagePassOfferQueryOptions() {
	return queryOptions({
		queryKey: ["payments-image-pass-offer"] as const,
		queryFn: ({ signal }) => orpcClient.payments.getImagePassOffer(undefined, { signal }),
		staleTime: 15_000,
		retry: false,
	});
}
