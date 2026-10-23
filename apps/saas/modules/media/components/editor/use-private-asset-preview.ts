"use client";

import { useSession } from "@auth/hooks/use-session";
import { orpcClient } from "@shared/lib/orpc-client";
import { skipToken, useQuery } from "@tanstack/react-query";

/** Share the same private URL boundary across current and legacy result previews. */
export function usePrivateAssetPreview(assetId?: string) {
	const { user } = useSession();
	const query = useQuery({
		queryKey: ["media-asset-preview", assetId, user?.id ?? null],
		queryFn: assetId
			? ({ signal }) =>
					orpcClient.media.getAssetAccessUrl({ assetId, disposition: "inline" }, { signal })
			: skipToken,
		staleTime: 4 * 60_000,
	});
	// TanStack retains successful data after a failed background refetch. A new
	// authorization denial must hide that URL even while its cache entry remains.
	const accessDenied = ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(
		(query.error as { code?: string } | null)?.code ?? "",
	);
	return { ...query, data: accessDenied ? undefined : query.data };
}
