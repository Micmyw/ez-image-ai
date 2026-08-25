import type { EditorProductKey } from "./editor-recovery";

export function resolveEditorProductSelection(
	productKey: EditorProductKey,
	allowedProductKeys: EditorProductKey[],
): { productKey: EditorProductKey; upgradeRequired: boolean } {
	return {
		productKey,
		upgradeRequired:
			productKey === "image-quality" && !allowedProductKeys.includes("image-quality"),
	};
}

export function canConfirmEditorUpgrade(
	productKey: EditorProductKey,
	allowedProductKeys: EditorProductKey[],
): boolean {
	return productKey === "image-quality" && allowedProductKeys.includes(productKey);
}
