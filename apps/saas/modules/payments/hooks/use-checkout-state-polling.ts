import { useRef } from "react";

import { createCheckoutStatePolling } from "../lib/checkout-state-polling";

export function useCheckoutStatePolling(scope: string | null, fastIntervalMs: number) {
	const polling = useRef<{
		scope: string | null;
		controller: ReturnType<typeof createCheckoutStatePolling>;
	} | null>(null);
	if (!polling.current || polling.current.scope !== scope) {
		polling.current = { scope, controller: createCheckoutStatePolling(fastIntervalMs) };
	}
	return polling.current.controller;
}
