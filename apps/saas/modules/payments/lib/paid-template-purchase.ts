import type { WorkspaceStorage } from "../../media/lib/workspace-draft";

export type PaidTemplatePurchase = "image-pass" | "plans";
const key = "ezpic.paid-template-purchase.v1";
const maximumAge = 10 * 60_000;

/** Only the selected purchase destination crosses sign-in. No photo, token or payment authority. */
export function savePaidTemplatePurchase(
	storage: WorkspaceStorage,
	input: { effectId: string; presetId: string; purchase: PaidTemplatePurchase },
	now = Date.now(),
): boolean {
	try {
		storage.setItem(key, JSON.stringify({ ...input, savedAt: now }));
		return true;
	} catch {
		return false;
	}
}

export function readPaidTemplatePurchase(
	storage: WorkspaceStorage,
	input: { effectId: string; presetId: string },
	now = Date.now(),
): PaidTemplatePurchase | null {
	try {
		const raw = storage.getItem(key);
		if (!raw || raw.length > 1_000) return null;
		const saved = JSON.parse(raw);
		if (
			saved.effectId !== input.effectId ||
			saved.presetId !== input.presetId ||
			typeof saved.savedAt !== "number" ||
			saved.savedAt > now ||
			now - saved.savedAt > maximumAge ||
			!["image-pass", "plans"].includes(saved.purchase)
		)
			return null;
		return saved.purchase;
	} catch {
		return null;
	}
}

export function clearPaidTemplatePurchase(storage: WorkspaceStorage): void {
	try {
		storage.removeItem(key);
	} catch {
		/* Storage may become unavailable after sign-in. */
	}
}
