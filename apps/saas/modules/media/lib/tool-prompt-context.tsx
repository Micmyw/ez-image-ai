"use client";

import type { ImageAspectRatio } from "@repo/config/client";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";

export type ToolPromptOptions = { aspectRatio?: ImageAspectRatio; clearReference?: boolean };
type Binding = {
	prompt: string;
	busy: boolean;
	applyPrompt: (prompt: string, options?: ToolPromptOptions) => boolean | void;
};
type ToolPrompt = {
	initialPrompt: string;
	initialAspectRatio?: ImageAspectRatio;
	returnPath?: "/christmas-wallpaper";
	allowPrinting: boolean;
	allowReference: boolean;
	prompt: string;
	busy: boolean;
	ready: boolean;
	apply: (prompt: string, options?: ToolPromptOptions) => boolean;
	bind: (binding: React.RefObject<Binding>) => () => void;
	report: (prompt: string, busy: boolean) => void;
};

const ToolPromptContext = createContext<ToolPrompt | null>(null);

/** Tools supply public editing instructions; uploads, model selection and submission stay in the editor. */
export function ToolPromptProvider({
	initialPrompt,
	initialAspectRatio,
	returnPath,
	allowPrinting = false,
	allowReference = true,
	children,
}: {
	initialPrompt: string;
	initialAspectRatio?: ImageAspectRatio;
	returnPath?: "/christmas-wallpaper";
	allowPrinting?: boolean;
	allowReference?: boolean;
	children: ReactNode;
}) {
	const binding = useRef<React.RefObject<Binding> | null>(null);
	const [state, setState] = useState({ prompt: initialPrompt, busy: false, ready: false });
	const bind = useCallback((next: React.RefObject<Binding>) => {
		binding.current = next;
		setState((current) => ({ ...current, ready: true }));
		return () => {
			if (binding.current === next) {
				binding.current = null;
				setState((current) => ({ ...current, ready: false }));
			}
		};
	}, []);
	const report = useCallback((prompt: string, busy: boolean) => {
		setState((current) =>
			current.prompt === prompt && current.busy === busy ? current : { ...current, prompt, busy },
		);
	}, []);
	const apply = useCallback((prompt: string, options?: ToolPromptOptions) => {
		const current = binding.current?.current;
		if (!current || current.busy || !prompt.trim() || prompt.length > 10_000) return false;
		return current.applyPrompt(prompt, options) !== false;
	}, []);
	const value = useMemo(
		() => ({
			initialPrompt,
			initialAspectRatio,
			returnPath,
			allowPrinting,
			allowReference,
			...state,
			bind,
			report,
			apply,
		}),
		[
			initialPrompt,
			initialAspectRatio,
			returnPath,
			allowPrinting,
			allowReference,
			state,
			bind,
			report,
			apply,
		],
	);
	return <ToolPromptContext.Provider value={value}>{children}</ToolPromptContext.Provider>;
}

export function useToolPrompt() {
	return useContext(ToolPromptContext);
}

export function useToolPromptBinding(value: Binding) {
	const context = useToolPrompt();
	const ref = useRef(value);
	ref.current = value;
	const bind = context?.bind;
	const report = context?.report;
	useEffect(() => bind?.(ref), [bind]);
	useEffect(() => report?.(value.prompt, value.busy), [report, value.prompt, value.busy]);
}
