import type { EditorProductKey } from "./editor-recovery";

export function resolveEditorProductSelection(
	productKey: EditorProductKey,
	allowedProductKeys: EditorProductKey[],
): { productKey: EditorProductKey; upgradeRequired: boolean } {
	return {
		productKey,
		upgradeRequired: !allowedProductKeys.includes(productKey),
	};
}

export function canConfirmEditorUpgrade(
	productKey: EditorProductKey,
	allowedProductKeys: EditorProductKey[],
): boolean {
	return allowedProductKeys.includes(productKey);
}
