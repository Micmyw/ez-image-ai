"use client";

import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { getGuestCapability } from "./guest-draft-client";

/** Browser-query cache only. Never dehydrate request-specific eligibility into public HTML. */
export const guestCapabilityQueryOptions = queryOptions({
	queryKey: ["guest-capability"] as const,
	queryFn: ({ signal }) =>
		getGuestCapability((input, init) =>
			fetch(input, {
				...init,
				cache: "no-store",
				signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
			}),
		),
	staleTime: 30_000,
	gcTime: 60_000,
	retry: false,
});

/** An explicit retry must not reuse either a stale result or an in-flight failed attempt. */
export async function refreshGuestCapability(queryClient: QueryClient) {
	await queryClient.cancelQueries({ queryKey: guestCapabilityQueryOptions.queryKey, exact: true });
	await queryClient.invalidateQueries({
		queryKey: guestCapabilityQueryOptions.queryKey,
		exact: true,
		refetchType: "none",
	});
	return queryClient.fetchQuery(guestCapabilityQueryOptions);
}
