import { PUBLIC_CREDIT_PACKS } from "@repo/config/client";

type PackKey = (typeof PUBLIC_CREDIT_PACKS)[number]["packKey"];
function storageKey(ownerId: string, organizationId: string | null, packKey: PackKey) {
	return `credit-pack-checkout:${JSON.stringify([ownerId, organizationId, packKey])}`;
}
export function readCreditPackCheckoutContext(
	ownerId: string,
	organizationId: string | null,
	packKey: PackKey,
): string | undefined {
	try {
		const intentId = window.sessionStorage.getItem(storageKey(ownerId, organizationId, packKey));
		return intentId && intentId.length <= 128 ? intentId : undefined;
	} catch {
		return undefined;
	}
}
// Recovery stores only the intent ID; the key scopes it to the current account and public pack.
export function saveCreditPackCheckoutContext(
	ownerId: string,
	organizationId: string | null,
	packKey: PackKey,
	intentId: string,
): void {
	if (!intentId || intentId.length > 128) return;
	try {
		window.sessionStorage.setItem(storageKey(ownerId, organizationId, packKey), intentId);
	} catch {
		/* Recovery remains optional. */
	}
}
export function clearCreditPackCheckoutContext(
	ownerId: string,
	organizationId: string | null,
	intentId: string,
): void {
	for (const { packKey } of PUBLIC_CREDIT_PACKS) {
		try {
			if (readCreditPackCheckoutContext(ownerId, organizationId, packKey) === intentId)
				window.sessionStorage.removeItem(storageKey(ownerId, organizationId, packKey));
		} catch {
			/* An older result must not block a newer checkout. */
		}
	}
}
