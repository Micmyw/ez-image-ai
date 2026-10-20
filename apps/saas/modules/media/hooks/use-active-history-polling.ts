"use client";

import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { mergeActiveHistory, readActiveHistory, type LoadedHistory } from "../lib/active-history";

export function useActiveHistoryPolling<TItem, TUpdate>(options: {
	queryKey: QueryKey;
	data: LoadedHistory<TItem> | undefined;
	enabled: boolean;
	interval: number;
	getId: (item: TItem) => string;
	isActive: (item: TItem) => boolean;
	detailKey: (id: string) => QueryKey;
	read: (id: string, signal: AbortSignal) => Promise<TUpdate>;
	merge: (item: TItem, update: TUpdate) => TItem | null;
}) {
	const client = useQueryClient();
	const latest = useRef(options);
	latest.current = options;
	const key = hashKey(options.queryKey);
	const running =
		options.enabled &&
		Boolean(options.data?.pages.some((page) => page.items.some(options.isActive)));
	const interval = options.interval;
	useEffect(() => {
		if (!running) return;
		const controller = new AbortController();
		const queryKey = latest.current.queryKey;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			const current = latest.current;
			const data = client.getQueryData<LoadedHistory<TItem>>(queryKey);
			const updatedAt = client.getQueryState(queryKey)?.dataUpdatedAt;
			try {
				if (!data || controller.signal.aborted) return;
				const updates = await readActiveHistory({
					data,
					getId: current.getId,
					isActive: current.isActive,
					signal: controller.signal,
					read: (id) =>
						client.fetchQuery({
							queryKey: current.detailKey(id),
							queryFn: ({ signal }) => current.read(id, signal),
							staleTime: interval,
							retry: false,
						}),
				});
				if (controller.signal.aborted) return;
				// A list refresh must finish before details can be merged. Otherwise its
				// slower response could overwrite this newer detail state afterward.
				const state = client.getQueryState(queryKey);
				if (state?.fetchStatus !== "idle" || state.dataUpdatedAt !== updatedAt) return;
				const cached = client.getQueryData<LoadedHistory<TItem>>(queryKey);
				if (!cached) return;
				const next = mergeActiveHistory(cached, updates, current.getId, current.merge);
				if (next !== cached) client.setQueryData(queryKey, next, { updatedAt });
			} finally {
				if (!controller.signal.aborted) timer = setTimeout(() => void poll(), interval);
			}
		};
		timer = setTimeout(() => void poll(), interval);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [client, key, running, interval]);
}
