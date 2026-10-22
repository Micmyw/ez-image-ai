"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { connectMediaJobEvents } from "../lib/job-events";

const subscriptions = new WeakMap<QueryClient, Map<string, { users: number; close(): void }>>();

export function useJobEvents(input: {
	jobId: string | null;
	ownerId?: string;
	enabled: boolean;
	queryKey: readonly unknown[];
}): void {
	const queryClient = useQueryClient();
	const { jobId, ownerId, enabled } = input;
	const queryKeyJson = JSON.stringify(input.queryKey);
	useEffect(() => {
		if (!enabled || !jobId || !ownerId || typeof WebSocket === "undefined") return;
		const key = JSON.stringify([ownerId, jobId, queryKeyJson]);
		const entries = subscriptions.get(queryClient) ?? new Map();
		subscriptions.set(queryClient, entries);
		let entry = entries.get(key);
		if (!entry) {
			const queryKey: unknown[] = JSON.parse(queryKeyJson);
			const url = new URL(
				`/api/media/jobs/${encodeURIComponent(jobId)}/events`,
				window.location.href,
			);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			let current = true;
			const close = connectMediaJobEvents({
				jobId,
				url: url.toString(),
				refresh: async () => {
					// An earlier in-flight read may predate the commit. Restart it rather than
					// accepting its stale snapshot and waiting for another polling interval.
					await queryClient.cancelQueries({ queryKey, exact: true });
					if (current)
						await queryClient.refetchQueries(
							{ queryKey, exact: true, type: "active" },
							{ throwOnError: true },
						);
				},
			});
			entry = {
				users: 0,
				close: () => {
					current = false;
					close();
					void queryClient.cancelQueries({ queryKey, exact: true });
				},
			};
			entries.set(key, entry);
		}
		entry.users += 1;
		return () => {
			entry.users -= 1;
			if (entry.users === 0) {
				entries.delete(key);
				entry.close();
			}
		};
	}, [enabled, jobId, ownerId, queryClient, queryKeyJson]);
}
