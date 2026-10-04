"use client";

import { useSession } from "@auth/hooks/use-session";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { videoApi } from "./api";
import { getVideoErrorKey, videoPollInterval } from "./model";

export function useVideoCatalog() {
	const { user } = useSession();
	return useQuery({
		queryKey: ["video-v1", "catalog", user?.id],
		queryFn: () => videoApi.catalog(),
		enabled: Boolean(user && !user.isAnonymous),
		staleTime: 30_000,
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
