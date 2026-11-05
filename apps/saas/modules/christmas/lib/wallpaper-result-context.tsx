"use client";

import { useSession } from "@auth/hooks/use-session";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";

export type WallpaperResult = {
	assetId: string;
	imageUrl?: string;
	expiresAt?: string;
};

type PreviewSource = "result" | "example";

const WallpaperResultContext = createContext<{
	result: WallpaperResult | null;
	publish: (result: WallpaperResult) => () => void;
	source: PreviewSource;
	selectSource: (source: PreviewSource) => void;
} | null>(null);

export function WallpaperResultProvider({ children }: { children: ReactNode }) {
	const { user } = useSession();
	const owner = user?.id ?? null;
	const [published, setPublished] = useState<{
		owner: string | null;
		result: WallpaperResult;
	} | null>(null);
	const [selection, setSelection] = useState<{
		owner: string | null;
		assetId: string;
		source: PreviewSource;
	} | null>(null);
	const publish = useCallback(
		(result: WallpaperResult) => {
			const entry = { owner, result };
			setPublished(entry);
			return () => setPublished((current) => (current === entry ? null : current));
		},
		[owner],
	);
	const result = published?.owner === owner ? published.result : null;
	const source = result
		? selection?.owner === owner && selection.assetId === result.assetId
			? selection.source
			: "result"
		: "example";
	const selectSource = useCallback(
		(source: PreviewSource) => {
			if (result) setSelection({ owner, assetId: result.assetId, source });
		},
		[owner, result],
	);
	const value = useMemo(
		() => ({ result, publish, source, selectSource }),
		[result, publish, source, selectSource],
	);
	return (
		<WallpaperResultContext.Provider value={value}>{children}</WallpaperResultContext.Provider>
	);
}

export function useWallpaperPreview() {
	const context = useContext(WallpaperResultContext);
	if (!context) throw new Error("Wallpaper preview requires WallpaperResultProvider");
	return context;
}

/** The selected ready result owns the preview; changing jobs or losing access clears it. */
export function WallpaperResultPublisher({ assetId, imageUrl, expiresAt }: WallpaperResult) {
	const publish = useContext(WallpaperResultContext)?.publish;
	useEffect(() => {
		const deadline = expiresAt ? Date.parse(expiresAt) : null;
		if (!publish || (deadline !== null && (!Number.isFinite(deadline) || deadline <= Date.now())))
			return;
		const clear = publish({ assetId, imageUrl, expiresAt });
		let timer: ReturnType<typeof setTimeout> | undefined;
		function checkExpiry() {
			if (deadline === null) return;
			const remaining = deadline - Date.now();
			if (remaining <= 0) clear();
			else timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
		}
		checkExpiry();
		return () => {
			clearTimeout(timer);
			clear();
		};
	}, [publish, assetId, imageUrl, expiresAt]);
	return null;
}
