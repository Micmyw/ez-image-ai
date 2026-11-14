import { isGuestTrialModel } from "@repo/config/guest-trial";

import type { GuestProductAccessHint, GuestProductKey } from "./guest-draft-client";

export function isProductAccessHintForKey(
	value: unknown,
	productKey: GuestProductKey,
	skuKey?: string,
): value is GuestProductAccessHint {
	return (
		skuKey !== undefined
			? isGuestTrialModel(productKey, skuKey)
			: productKey === "image-nano-banana-2-lite" || productKey === "image-minimax-h3"
	)
		? value === "guest-trial"
		: value === "paid-account";
}
