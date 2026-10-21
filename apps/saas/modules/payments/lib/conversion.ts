import { trackBrowserGrowthEvent } from "@repo/utils/lib/growth-analytics-browser";

type ProductKind = "PLAN" | "CREDIT_PACK" | "IMAGE_PASS";
type Stage = "purchase_clicked" | "checkout_requested" | "checkout_redirected" | "checkout_failed";

export function trackCheckoutStage(name: Stage, productKind: ProductKind, error?: unknown) {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	const errorCategory =
		name === "checkout_failed"
			? code === "CONFLICT"
				? "conflict"
				: code === "UNAUTHORIZED"
					? "unauthorized"
					: code === "SERVICE_UNAVAILABLE"
						? "unavailable"
						: error instanceof TypeError
							? "network"
							: "unknown"
			: undefined;
	void trackBrowserGrowthEvent({
		name,
		properties: { productKind, ...(errorCategory ? { errorCategory } : {}) },
	}).catch(() => undefined);
}
