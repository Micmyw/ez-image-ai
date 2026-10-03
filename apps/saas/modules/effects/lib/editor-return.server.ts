import "server-only";
import { getPublishedEffectBySlug } from "./content";
import { sanitizeEffectEditorReturnPath } from "./editor-selection";
import { effectPath } from "./types";

/** Handoffs return only to a currently published effect and a registered preset. */
export function resolvePublishedEffectReturnPath(value: unknown): string | null {
	const path = sanitizeEffectEditorReturnPath(value);
	if (!path) return null;
	const url = new URL(path, "https://effect-return.invalid");
	const effect = getPublishedEffectBySlug(url.pathname.slice("/effects/".length));
	const presetId = url.searchParams.get("preset");
	if (!effect || !presetId || !effect.presets.some((preset) => preset.id === presetId)) return null;
	return effectPath(effect, presetId);
}
