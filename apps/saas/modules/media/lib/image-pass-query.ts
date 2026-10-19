import { orpcClient } from "@shared/lib/orpc-client";
import { queryOptions } from "@tanstack/react-query";

export function imagePassBalanceQueryKey(ownerId: string | null) {
	return ["media-image-pass-balance", ownerId] as const;
}

export function imagePassBalanceQueryOptions(ownerId: string | null) {
	return queryOptions({
		queryKey: imagePassBalanceQueryKey(ownerId),
		enabled: Boolean(ownerId),
		queryFn: async ({ signal }) => {
			if (!ownerId) throw new Error("An image pass owner is required");
			const result = await orpcClient.media.getImagePassBalance(undefined, { signal });
			signal.throwIfAborted();
			return result;
		},
	});
}
