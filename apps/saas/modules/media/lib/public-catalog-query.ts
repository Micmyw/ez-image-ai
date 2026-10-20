import { orpcClient } from "@shared/lib/orpc-client";
import { queryOptions } from "@tanstack/react-query";

export const publicCatalogQueryOptions = queryOptions({
	queryKey: ["media-catalog"],
	queryFn: ({ signal }) =>
		orpcClient.media.getPublicCatalog(undefined, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
		}),
	staleTime: 5 * 60_000,
});
