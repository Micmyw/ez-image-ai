"use client";

import { createContext, useContext } from "react";

export type StudioPanel = {
	kind: "general" | "security" | "notifications" | "billing" | "history" | "assets";
	jobId?: string;
};
export const STUDIO_ASSET_SELECTED_EVENT = "ezpic:studio-asset-selected";

export function studioPanelForPath(pathname: string): StudioPanel | null {
	if (pathname === "/assets") return { kind: "assets" };
	if (pathname === "/history") return { kind: "history" };
	const job = /^\/history\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
	if (job) return { kind: "history", jobId: decodeURIComponent(job[1]!) };
	const settings = /^\/settings\/(general|security|notifications|billing)$/.exec(pathname);
	return settings ? { kind: settings[1] as StudioPanel["kind"] } : null;
}

export const StudioContext = createContext<{
	openPanel: (panel: StudioPanel) => void;
	closePanel: () => void;
} | null>(null);

export function useStudio() {
	return useContext(StudioContext);
}
