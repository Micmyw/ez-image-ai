"use client";

import { useEffect, useState } from "react";

import { editorContinuePath } from "../lib/editor-upgrade";

/** Resolves after hydration so server and client markup agree on "/create". */
export function useEditorContinuePath(): string {
	const [path, setPath] = useState("/create");
	useEffect(() => {
		let storage: Storage | null = null;
		try {
			storage = window.sessionStorage;
		} catch {
			storage = null;
		}
		setPath(editorContinuePath(storage));
	}, []);
	return path;
}
