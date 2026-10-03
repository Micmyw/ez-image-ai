"use client";

import { createContext, useContext, useEffect, useRef } from "react";

import type { EffectPageContent, PublicEffectPreset } from "./types";

export interface EffectEditorBinding {
	getPrompt: () => string;
	hasCustomChanges?: (preset: PublicEffectPreset) => boolean;
	isBusy: () => boolean;
	applyPreset: (preset: PublicEffectPreset) => void;
}

export interface EffectEditorContextValue {
	effect: EffectPageContent;
	preview: boolean;
	selectedPreset: PublicEffectPreset;
	prompt: string;
	isBusy: boolean;
	requestPreset: (id: string) => void;
	focusEditor: () => void;
	bindEditor: (binding: EffectEditorBinding) => () => void;
	updateEditor: (prompt: string, busy: boolean) => void;
	getReturnPath: (recovery?: "upgrade" | "resume") => string;
	getAnalyticsContext: () =>
		| { effect_id: string; preset_id: string; preset_version: number; entry_path: string }
		| undefined;
	resultContainer: HTMLElement | null;
	setResultContainer: (node: HTMLElement | null) => void;
	hasResult: boolean;
	setResultActive: (active: boolean) => void;
}

export const EffectEditorContext = createContext<EffectEditorContextValue | null>(null);

export function useEffectEditor() {
	return useContext(EffectEditorContext);
}

/** The existing form owns state; the surrounding effect UI only reads it or requests a change. */
export function useEffectEditorBinding({
	prompt,
	busy,
	applyPreset,
	hasCustomChanges,
}: {
	prompt: string;
	busy: boolean;
	applyPreset: (preset: PublicEffectPreset) => void;
	hasCustomChanges?: (preset: PublicEffectPreset) => boolean;
}) {
	const context = useEffectEditor();
	const current = useRef({ prompt, busy, applyPreset, hasCustomChanges });
	current.current = { prompt, busy, applyPreset, hasCustomChanges };
	const bindEditor = context?.bindEditor;
	const updateEditor = context?.updateEditor;
	useEffect(
		() =>
			bindEditor?.({
				getPrompt: () => current.current.prompt,
				hasCustomChanges: (preset) =>
					current.current.hasCustomChanges?.(preset) ??
					(current.current.prompt.length > 0 && current.current.prompt !== preset.prompt),
				isBusy: () => current.current.busy,
				applyPreset: (preset) => current.current.applyPreset(preset),
			}),
		[bindEditor],
	);
	useEffect(() => {
		updateEditor?.(prompt, busy);
	}, [updateEditor, prompt, busy]);
}
