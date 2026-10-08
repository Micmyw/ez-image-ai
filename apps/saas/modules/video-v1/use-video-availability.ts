"use client";

import { useSession } from "@auth/hooks/use-session";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { videoApi } from "./api";

/** The sidebar must not fetch all model prices on every public-page visit. */
export function useVideoAvailability() {
	const { user } = useSession();
	const queryClient = useQueryClient();
	const owner = user?.id;
	const enabled = Boolean(user && !user.isAnonymous);
	useEffect(() => {
		if (!enabled) return;
		const cache = queryClient.getQueryCache();
		return cache.subscribe((event) => {
			if (
				event.type !== "updated" ||
				(event.action.type !== "success" && event.action.type !== "invalidate") ||
				!cache.findAll({ queryKey: orpc.payments.key() }).includes(event.query)
			)
				return;
			void queryClient.invalidateQueries(
				{ queryKey: ["video-v1", "availability", owner], exact: true },
				{ cancelRefetch: false },
			);
		});
	}, [enabled, owner, queryClient]);
	return useQuery({
		queryKey: ["video-v1", "availability", owner],
		queryFn: () => videoApi.availability(),
		enabled,
		staleTime: 30_000,
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		refetchInterval: (query) => {
			const until = query.state.data?.pricingValidUntil;
			const remaining = until ? Date.parse(until) - Date.now() : 0;
			return remaining > 0 ? Math.min(30_000, remaining + 25) : 30_000;
		},
		refetchIntervalInBackground: false,
		retry: false,
	});
}
