import type { GuestProductAccessHint, GuestProductKey } from "./guest-draft-client";

export function isProductAccessHintForKey(
	value: unknown,
	productKey: GuestProductKey,
): value is GuestProductAccessHint {
	return productKey === "image-nano-banana-2-lite"
		? value === "guest-trial"
		: value === "paid-account";
}
