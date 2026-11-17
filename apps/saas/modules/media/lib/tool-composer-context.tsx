"use client";

import { createContext, useContext, type ReactNode } from "react";

/** Presentation slots only. The existing form still owns uploads, quotes and submission. */
type ToolComposer = {
	beforeReference: ReactNode;
	afterReference: ReactNode;
	summary: ReactNode;
};

const ToolComposerContext = createContext<ToolComposer | null>(null);
export const ToolComposerProvider = ToolComposerContext.Provider;
export function useToolComposer() {
	return useContext(ToolComposerContext);
}
