"use client";

import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { getGuestCapability, getGuestCapabilityPresentation } from "./guest-draft-client";

function uncachedGuestFetch(signal: AbortSignal): typeof fetch {
	return (input, init) =>
		fetch(input, {
			...init,
			cache: "no-store",
			signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
		});
}

/** Browser-query cache only. Never dehydrate request-specific eligibility into public HTML. */
export const guestCapabilityQueryOptions = queryOptions({
	queryKey: ["guest-capability"] as const,
	queryFn: ({ signal }) => getGuestCapabilityPresentation(uncachedGuestFetch(signal)),
	staleTime: 30_000,
	gcTime: 60_000,
	retry: false,
});

export const fullGuestCapabilityQueryOptions = queryOptions({
	queryKey: [...guestCapabilityQueryOptions.queryKey, "full"] as const,
	queryFn: ({ signal }) => getGuestCapability(uncachedGuestFetch(signal)),
	staleTime: 0,
	gcTime: 60_000,
	retry: false,
});

/** An explicit retry must not reuse either a stale result or an in-flight failed attempt. */
export async function refreshGuestCapability(queryClient: QueryClient) {
	await queryClient.cancelQueries({ queryKey: guestCapabilityQueryOptions.queryKey });
	await queryClient.invalidateQueries({
		queryKey: guestCapabilityQueryOptions.queryKey,
		exact: true,
		refetchType: "none",
	});
	return queryClient.fetchQuery(guestCapabilityQueryOptions);
}
