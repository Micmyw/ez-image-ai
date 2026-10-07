"use client";

import { createContext, useContext, useEffect } from "react";

import type { GeneratorMode } from "./generator-navigation";

export type SignInDraftSaver = (destination: URL) => void | Promise<void>;

export const GenerationModeContext = createContext<{
	mode: GeneratorMode;
	selectMode: (mode: GeneratorMode) => void;
	registerSignInDraft: (save: SignInDraftSaver) => () => void;
	prepareSignIn: (destination: string) => Promise<string>;
} | null>(null);

export const useGenerationMode = () => useContext(GenerationModeContext);

/** Flush both mounted drafts only for an explicit sign-in from this workspace. */
export function useGeneratorSignInDraft(save: SignInDraftSaver) {
	const register = useGenerationMode()?.registerSignInDraft;
	useEffect(() => register?.(save), [register, save]);
}
