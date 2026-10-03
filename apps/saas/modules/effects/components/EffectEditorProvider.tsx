"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/components/alert-dialog";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { recordEffectPresetSelected, setEffectAnalyticsContext } from "../lib/analytics";
import { EffectEditorContext, type EffectEditorBinding } from "../lib/editor-context";
import { needsEffectPresetConfirmation } from "../lib/editor-selection";
import {
	effectPath,
	resolveEffectPreset,
	type EffectPageContent,
	type PublicEffectPreset,
} from "../lib/types";
export { useEffectEditor } from "../lib/editor-context";

export function EffectEditorProvider({
	effect,
	initialPresetId,
	preview = false,
	sourceBlogId,
	allowedSourceBlogIds,
	internalSource,
	children,
}: {
	effect: EffectPageContent;
	initialPresetId?: string;
	preview?: boolean;
	sourceBlogId?: string;
	allowedSourceBlogIds?: readonly string[];
	internalSource?: "effects-directory" | "blog" | "home" | "image-to-image" | "model" | "effect";
	children: ReactNode;
}) {
	const t = useTranslations("effects.editor");
	const { userHasConsented } = useCookieConsent();
	const [selectedPreset, setSelectedPreset] = useState(() =>
		resolveEffectPreset(effect, initialPresetId),
	);
	const selectedRef = useRef(selectedPreset);
	selectedRef.current = selectedPreset;
	const [editor, setEditor] = useState({ prompt: selectedPreset.prompt, busy: false });
	const [pendingPreset, setPendingPreset] = useState<PublicEffectPreset | null>(null);
	const binding = useRef<EffectEditorBinding | null>(null);
	const [resultContainer, setResultContainer] = useState<HTMLElement | null>(null);
	const [hasResult, setResultActive] = useState(false);
	const isPreview = preview || effect.status !== "published";

	useEffect(() => {
		setEffectAnalyticsContext(effect, selectedPreset.id, {
			sourceBlogId,
			allowedSourceBlogIds,
			internalSource,
			preview: isPreview,
		});
	}, [
		effect,
		selectedPreset.id,
		sourceBlogId,
		allowedSourceBlogIds,
		internalSource,
		isPreview,
		userHasConsented,
	]);

	const focusEditor = useCallback(() => {
		const target = document.getElementById("image-editor");
		target?.scrollIntoView({
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			block: "start",
		});
		requestAnimationFrame(() => {
			(
				document.getElementById("landing-edit-prompt") ??
				document.getElementById("generation-prompt")
			)?.focus({ preventScroll: true });
		});
	}, []);
	const applyPreset = useCallback(
		(preset: PublicEffectPreset) => {
			if (binding.current?.isBusy()) return;
			binding.current?.applyPreset(preset);
			selectedRef.current = preset;
			setSelectedPreset(preset);
			setEditor((current) => ({ ...current, prompt: preset.prompt }));
			const url = new URL(window.location.href);
			url.searchParams.set("preset", preset.id);
			url.searchParams.delete("model");
			window.history.replaceState(null, "", url.pathname + url.search + url.hash);
			void recordEffectPresetSelected(effect, preset.id, {
				sourceBlogId,
				allowedSourceBlogIds,
				internalSource,
				preview: isPreview,
			});
			focusEditor();
		},
		[effect, sourceBlogId, allowedSourceBlogIds, internalSource, isPreview, focusEditor],
	);
	const requestPreset = useCallback(
		(id: string) => {
			const preset = effect.presets.find((candidate) => candidate.id === id);
			if (!preset || binding.current?.isBusy()) return;
			const prompt = binding.current?.getPrompt() ?? selectedRef.current.prompt;
			const customChanges =
				binding.current?.hasCustomChanges?.(selectedRef.current) ??
				needsEffectPresetConfirmation(prompt, selectedRef.current);
			if (customChanges) setPendingPreset(preset);
			else applyPreset(preset);
		},
		[effect.presets, applyPreset],
	);
	const bindEditor = useCallback((next: EffectEditorBinding) => {
		binding.current = next;
		return () => {
			if (binding.current === next) binding.current = null;
		};
	}, []);
	const updateEditor = useCallback((prompt: string, busy: boolean) => {
		setEditor((current) =>
			current.prompt === prompt && current.busy === busy ? current : { prompt, busy },
		);
	}, []);
	const getReturnPath = useCallback(
		(recovery?: "upgrade" | "resume") => {
			if (isPreview)
				return recovery
					? `/create?${recovery}=${recovery === "upgrade" ? "complete" : "text"}`
					: "/create";
			const path = effectPath(effect, selectedRef.current.id);
			return recovery
				? `${path}&${recovery}=${recovery === "upgrade" ? "complete" : "text"}`
				: path;
		},
		[effect, isPreview],
	);
	const getAnalyticsContext = useCallback(
		() =>
			isPreview
				? undefined
				: {
						effect_id: effect.id,
						preset_id: selectedRef.current.id,
						preset_version: selectedRef.current.version,
						entry_path: `/blog/${effect.slug}`,
					},
		[effect.id, effect.slug, isPreview],
	);
	const value = useMemo(
		() => ({
			effect,
			preview: isPreview,
			selectedPreset,
			prompt: editor.prompt,
			isBusy: editor.busy,
			requestPreset,
			focusEditor,
			bindEditor,
			updateEditor,
			getReturnPath,
			getAnalyticsContext,
			resultContainer,
			setResultContainer,
			hasResult,
			setResultActive,
		}),
		[
			effect,
			isPreview,
			selectedPreset,
			editor,
			requestPreset,
			focusEditor,
			bindEditor,
			updateEditor,
			getReturnPath,
			getAnalyticsContext,
			resultContainer,
			hasResult,
		],
	);

	return (
		<EffectEditorContext.Provider value={value}>
			{children}
			<AlertDialog
				open={pendingPreset !== null}
				onOpenChange={(open) => {
					if (!open) setPendingPreset(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("replaceTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("replaceDescription")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("keepPrompt")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (pendingPreset) applyPreset(pendingPreset);
								setPendingPreset(null);
							}}
						>
							{t("replacePrompt")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</EffectEditorContext.Provider>
	);
}
