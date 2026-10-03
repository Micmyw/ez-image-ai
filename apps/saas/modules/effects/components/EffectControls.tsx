"use client";

import { ChevronDownIcon, ImageIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { recordEffectPromptCopied } from "../lib/analytics";
import { useEffectEditor } from "./EffectEditorProvider";
import { EffectExample } from "./EffectExample";

export function EffectControls() {
	const editor = useEffectEditor();
	const t = useTranslations("effects");
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
	useEffect(() => setCopyState("idle"), [editor?.prompt]);
	if (!editor) return null;
	async function copy() {
		if (!editor) return;
		try {
			await navigator.clipboard.writeText(editor.prompt);
			setCopyState("copied");
			void recordEffectPromptCopied(editor.effect, editor.selectedPreset.id, {
				preview: editor.preview,
			});
		} catch {
			setCopyState("failed");
		}
	}
	return (
		<div className="effect-preset-controls">
			<label htmlFor="effect-preset">{t("choosePreset")}</label>
			<select
				id="effect-preset"
				className="effect-preset-select"
				value={editor.selectedPreset.id}
				disabled={editor.isBusy}
				onChange={(event) => {
					setCopyState("idle");
					editor.requestPreset(event.target.value);
				}}
			>
				{editor.effect.presets.map((preset) => (
					<option key={preset.id} value={preset.id}>
						{preset.name}
					</option>
				))}
			</select>
			<p className="effect-input-hint">{editor.selectedPreset.inputHint}</p>
			<div className="effect-current-copy">
				<details className="effect-current-disclosure">
					<summary>
						{t("currentPrompt")} <ChevronDownIcon size={16} aria-hidden="true" />
					</summary>
					<textarea
						className="effect-current-prompt w-full resize-y bg-transparent"
						readOnly
						rows={4}
						aria-label={t("currentPrompt")}
						value={editor.prompt}
					/>
				</details>
				<button type="button" onClick={() => void copy()}>
					{copyState === "copied" ? t("copied") : t("copyPrompt")}
				</button>
			</div>
			{copyState !== "idle" && (
				<output className="mt-2 text-sm text-violet-200 block" aria-live="polite">
					{copyState === "copied" ? t("copied") : t("copyFailed")}
				</output>
			)}
		</div>
	);
}

export function UseEffectPreset({ presetId }: { presetId: string }) {
	const editor = useEffectEditor();
	const t = useTranslations("effects");
	return (
		<button
			type="button"
			className="effect-button"
			disabled={editor?.isBusy}
			onClick={() => editor?.requestPreset(presetId)}
		>
			{t("usePreset")}
		</button>
	);
}

export function EffectPresetPrompt({ presetId }: { presetId: string }) {
	const editor = useEffectEditor();
	const t = useTranslations("effects");
	const preset = editor?.effect.presets.find((item) => item.id === presetId);
	const disclosure = useRef<HTMLDetailsElement>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
	useEffect(() => setCopyState("idle"), [preset?.prompt]);
	if (!editor || !preset) return null;
	async function copy() {
		if (!editor || !preset) return;
		try {
			await navigator.clipboard.writeText(preset.prompt);
			setCopyState("copied");
			void recordEffectPromptCopied(editor.effect, preset.id, { preview: editor.preview });
		} catch {
			setCopyState("failed");
			if (disclosure.current) disclosure.current.open = true;
		}
	}
	return (
		<div className="effect-preset-prompt">
			<div className="effect-preset-actions">
				<button type="button" className="effect-button is-secondary" onClick={() => void copy()}>
					{copyState === "copied" ? t("copied") : t("copyPrompt")}
				</button>
				<UseEffectPreset presetId={presetId} />
			</div>
			<details ref={disclosure} className="effect-prompt-disclosure">
				<summary>
					{t("fullPrompt")} <ChevronDownIcon size={16} aria-hidden="true" />
				</summary>
				<pre>{preset.prompt}</pre>
			</details>
			{copyState !== "idle" && (
				<output className="effect-copy-status" aria-live="polite">
					{copyState === "copied" ? t("copied") : t("copyFailed")}
				</output>
			)}
		</div>
	);
}

export function EffectExampleStage({ mobile = false }: { mobile?: boolean }) {
	const editor = useEffectEditor();
	const t = useTranslations("effects");
	if (!editor) return null;
	const example = editor.effect.examples.find(
		(item) =>
			editor.selectedPreset.exampleIds.includes(item.id) &&
			item.presetId === editor.selectedPreset.id &&
			item.presetVersion === editor.selectedPreset.version,
	);
	const sample = example ? (
		<EffectExample key={example.id} example={example} compact={mobile} />
	) : (
		<div className="effect-example-pending">
			<div>
				<ImageIcon size={30} className="text-violet-300 mx-auto" aria-hidden="true" />
				<p>{t("previewImagesPending")}</p>
			</div>
		</div>
	);
	if (mobile)
		return !editor.hasResult ? <div className="effect-mobile-example">{sample}</div> : null;
	return (
		<div className="effect-workbench-stage">
			{!editor.hasResult && <div className="effect-desktop-example">{sample}</div>}
			<div ref={editor.setResultContainer} id="effect-private-result" aria-live="polite" />
		</div>
	);
}
