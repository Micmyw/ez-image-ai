"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { isEditorProductKey, type EditorProductKey } from "../lib/editor-recovery";

export function imageModelHref(productKey: string) {
	return `/create?model=${encodeURIComponent(productKey)}`;
}

/** Keep manual choices shareable without remounting the form or its private input. */
export function replaceImageModelInUrl(productKey: string) {
	const url = new URL(window.location.href);
	if (url.searchParams.get("model") === productKey) return;
	url.searchParams.set("model", productKey);
	window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

export function useModelNavigation({
	products,
	value,
	onSelect,
	ready,
}: {
	products: readonly { key: string }[];
	value: string | null;
	onSelect: (key: EditorProductKey) => void;
	ready: boolean;
}) {
	const requested = useSearchParams().get("model");
	const applied = useRef<string | null>(null);
	const available = Boolean(
		requested &&
		isEditorProductKey(requested) &&
		products.some((product) => product.key === requested),
	);
	useEffect(() => {
		if (!requested) {
			applied.current = null;
			return;
		}
		if (!ready || !available || applied.current === requested || !isEditorProductKey(requested))
			return;
		applied.current = requested;
		if (value !== requested) onSelect(requested);
	}, [requested, available, ready, value, onSelect]);
	return { unavailable: Boolean(ready && requested && !available) };
}
