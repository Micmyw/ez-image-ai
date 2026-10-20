const FAST_POLL_WINDOW_MS = 120_000;
const SLOW_POLL_INTERVAL_MS = 30_000;

interface CheckoutQuery {
	state: {
		status: "pending" | "error" | "success";
		data?: { status: string };
	};
}

export function createCheckoutStatePolling(fastIntervalMs: number) {
	let pollingUntil = Date.now() + FAST_POLL_WINDOW_MS;
	return {
		restart: () => {
			pollingUntil = Date.now() + FAST_POLL_WINDOW_MS;
		},
		refetchInterval: (query: CheckoutQuery): number | false => {
			if (
				query.state.status === "error" ||
				(query.state.data && query.state.data.status !== "PENDING")
			)
				return false;
			return Date.now() < pollingUntil ? fastIntervalMs : SLOW_POLL_INTERVAL_MS;
		},
	};
}

export function subscribeToCheckoutForeground(refresh: (event: Event) => void) {
	const currentDocument = typeof document === "undefined" ? null : document;
	const visible = (event: Event) => {
		if (currentDocument?.visibilityState === "visible") refresh(event);
	};
	window.addEventListener("pageshow", refresh);
	window.addEventListener("focus", refresh);
	currentDocument?.addEventListener("visibilitychange", visible);
	return () => {
		window.removeEventListener("pageshow", refresh);
		window.removeEventListener("focus", refresh);
		currentDocument?.removeEventListener("visibilitychange", visible);
	};
}
