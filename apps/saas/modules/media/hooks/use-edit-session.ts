"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";

export function useEditSession(sessionId: string) {
	return useQuery({
		queryKey: ["media-edit-session", sessionId],
		queryFn: () => orpcClient.media.getEditSession({ sessionId }),
	});
}
