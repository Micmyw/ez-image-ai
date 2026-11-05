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

const WallpaperResultContext = createContext<{
	result: WallpaperResult | null;
	publish: (result: WallpaperResult) => () => void;
} | null>(null);

export function WallpaperResultProvider({ children }: { children: ReactNode }) {
	const { user } = useSession();
	const owner = user?.id ?? null;
	const [published, setPublished] = useState<{
		owner: string | null;
		result: WallpaperResult;
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
	const value = useMemo(() => ({ result, publish }), [result, publish]);
	return (
		<WallpaperResultContext.Provider value={value}>{children}</WallpaperResultContext.Provider>
	);
}

export function useWallpaperResult() {
	return useContext(WallpaperResultContext)?.result ?? null;
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
