"use client";

import { useSession } from "@auth/hooks/use-session";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { videoApi } from "./api";
import { getVideoErrorKey, videoPollInterval } from "./model";

export function useVideoCatalog() {
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
				{ queryKey: ["video-v1", "catalog", owner], exact: true },
				{ cancelRefetch: false },
			);
		});
	}, [enabled, owner, queryClient]);
	return useQuery({
		queryKey: ["video-v1", "catalog", owner],
		queryFn: () => videoApi.catalog(),
		enabled,
		staleTime: 30_000,
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		// Observe external refunds while the page remains open; an earlier known
		// subscription/grace expiry shortens the next foreground refresh.
		refetchInterval: (query) => {
			const until = query.state.data?.pricingValidUntil;
			const remaining = until ? Date.parse(until) - Date.now() : 0;
			return remaining > 0 ? Math.min(30_000, remaining + 25) : 30_000;
		},
		refetchIntervalInBackground: false,
		retry: false,
	});
}

export function usePageVisible() {
	const [visible, setVisible] = useState(true);
	useEffect(() => {
		const update = () => setVisible(document.visibilityState === "visible");
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}

export function useVideoJob(jobId: string) {
	const { user } = useSession();
	const visible = usePageVisible();
	return useQuery({
		queryKey: ["video-v1", "job", user?.id, jobId],
		queryFn: () => videoApi.jobs.get({ jobId }),
		enabled: Boolean(user && !user.isAnonymous && jobId),
		retry: false,
		refetchInterval: (query) =>
			query.state.error && getVideoErrorKey(query.state.error) === "unauthorized"
				? false
				: videoPollInterval(query.state.data?.stage, visible),
		refetchIntervalInBackground: false,
	});
}
