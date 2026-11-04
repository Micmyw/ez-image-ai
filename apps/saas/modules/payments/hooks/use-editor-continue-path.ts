"use client";

import { useEffect, useState } from "react";

import { workspaceDraftReturnPath } from "../../media/lib/workspace-draft";

/** Resolves after hydration so server and client markup agree on "/create". */
export function useEditorContinuePath(ownerId: string | null | undefined): string {
	const [resolved, setResolved] = useState<{ ownerId: string; path: string } | null>(null);
	useEffect(() => {
		if (!ownerId) return;
		let storage: Storage | null = null;
		try {
			storage = window.sessionStorage;
		} catch {
			storage = null;
		}
		setResolved({ ownerId, path: workspaceDraftReturnPath(storage, ownerId) });
	}, [ownerId]);
	return resolved && resolved.ownerId === ownerId ? resolved.path : "/create";
}
