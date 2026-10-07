"use client";

import { createContext, useContext, useEffect } from "react";

import type { GeneratorMode } from "./generator-navigation";

export const GenerationModeContext = createContext<{
	mode: GeneratorMode;
	selectMode: (mode: GeneratorMode) => void;
	registerSignInDraft: (save: (destination: URL) => void) => () => void;
	prepareSignIn: (destination: string) => string;
} | null>(null);

export const useGenerationMode = () => useContext(GenerationModeContext);

/** Flush both mounted drafts only for an explicit sign-in from this workspace. */
export function useGeneratorSignInDraft(save: (destination: URL) => void) {
	const register = useGenerationMode()?.registerSignInDraft;
	useEffect(() => register?.(save), [register, save]);
}
