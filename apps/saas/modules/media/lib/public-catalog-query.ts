import { orpcClient } from "@shared/lib/orpc-client";
import { queryOptions } from "@tanstack/react-query";

export const publicCatalogQueryOptions = queryOptions({
	queryKey: ["media-catalog"],
	queryFn: () => orpcClient.media.getPublicCatalog(),
	staleTime: 5 * 60_000,
});
