"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { isEditorProductKey, type EditorProductKey } from "../lib/editor-recovery";

const imageToolModels: Record<string, EditorProductKey | undefined> = {
	"/minimax-h3-image": "image-minimax-h3",
	"/seedream-5-5": "image-seedream-5-5",
	"/gpt-image-2-6-flare": "image-gpt-image-2-6-flare",
	"/gpt-image-2-6-sunburst": "image-gpt-image-2-6-sunburst",
	"/gpt-image-2-6": "image-gpt-image-2-6-flare",
	"/ai-svg-generator": "image-gpt-image-2-6-flare",
	"/ai-gif-generator": "image-gpt-image-2-6-flare",
};

export function imageModelHref(productKey: string) {
	if (productKey === "image-minimax-h3") return "/minimax-h3-image";
	if (productKey === "image-seedream-5-5") return "/seedream-5-5";
	if (productKey === "image-gpt-image-2-6-flare" || productKey === "image-gpt-image-2-6-sunburst")
		return `/${productKey.slice("image-".length)}`;
	return `/models/${encodeURIComponent(productKey.replace(/^image-/, ""))}`;
}

export function resolveRequestedImageOutputFormat(pathname: string) {
	return pathname === "/ai-svg-generator"
		? "svg"
		: pathname === "/ai-gif-generator"
			? "gif"
			: undefined;
}

export function useRequestedImageOutputFormat() {
	return resolveRequestedImageOutputFormat(usePathname());
}

export function useRequestedImageModel() {
	const pathname = usePathname();
	return resolveRequestedImageModel(pathname, useSearchParams().get("model"));
}

export function resolveRequestedImageModel(pathname: string, queryModel: string | null) {
	const slug = pathname.startsWith("/models/") ? pathname.slice("/models/".length) : null;
	const routeModel = slug ? `image-${slug}` : (imageToolModels[pathname] ?? null);
	if (
		resolveRequestedImageOutputFormat(pathname) &&
		queryModel &&
		!["image-gpt-image-2-6-flare", "image-gpt-image-2-6-sunburst"].includes(queryModel)
	)
		return routeModel;
	if (queryModel && (isEditorProductKey(queryModel) || !routeModel)) return queryModel;
	return routeModel;
}

/** Keep manual choices shareable without remounting the form or its private input. */
export function replaceImageModelInUrl(productKey: string) {
	const url = new URL(window.location.href);
	if (url.searchParams.get("model") === productKey) return;
	url.searchParams.set("model", productKey);
	url.searchParams.delete("job");
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
	const requested = useRequestedImageModel();
	const applied = useRef<string | null>(requested);
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
