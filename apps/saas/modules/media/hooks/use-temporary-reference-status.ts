"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

import { temporaryReferenceReviewPollingInterval } from "../lib/temporary-reference-review";
import type { TemporaryReferenceReceipt } from "../lib/temporary-reference-upload";
import { usePageVisible } from "./use-page-visible";

export function useTemporaryReferenceStatus({
	ownerId,
	reference,
	enabled,
}: {
	ownerId: string | null;
	reference?: TemporaryReferenceReceipt;
	enabled: boolean;
}) {
	const visible = usePageVisible();
	const active = Boolean(ownerId && reference && enabled && visible);
	const options = orpc.media.getTemporaryReferenceStatus.queryOptions({
		input: { assetId: reference?.assetId ?? "", token: reference?.token ?? "" },
	});
	return useQuery({
		...options,
		queryKey: [...options.queryKey, { ownerId }],
		enabled: active,
		retry: false,
		staleTime: 0,
		gcTime: 0,
		refetchInterval: (query) =>
			temporaryReferenceReviewPollingInterval({
				enabled: active,
				data: query.state.data,
				error: query.state.error,
			}),
	});
}
