import { orpcClient } from "@shared/lib/orpc-client";
import { queryOptions } from "@tanstack/react-query";

export function creditAccountOwnerId({
	loaded,
	user,
}: {
	loaded: boolean;
	user: { id: string; isAnonymous?: boolean | null } | null;
}) {
	return loaded && user && user.isAnonymous !== true ? user.id : null;
}

export function creditAccountQueryKey(ownerId: string | null) {
	return ["media-credit-account", ownerId] as const;
}

export function creditAccountQueryOptions(ownerId: string | null) {
	return queryOptions({
		queryKey: creditAccountQueryKey(ownerId),
		enabled: Boolean(ownerId),
		queryFn: async ({ signal }) => {
			if (!ownerId) throw new Error("A credit account owner is required");
			const result = await orpcClient.media.getCreditAccount(undefined, { signal });
			signal.throwIfAborted();
			return result;
		},
	});
}
