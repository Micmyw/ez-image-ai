"use client";

import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";

import { useEffectEditor } from "./EffectEditorProvider";

export function IllustratedPresetPicker() {
	const editor = useEffectEditor();
	const t = useTranslations("effects");
	if (!editor) return null;
	return (
		<div className="illustrated-preset-picker">
			<p className="illustrated-preset-label" id="illustrated-preset-label">
				{t("choosePreset")}
			</p>
			<fieldset className="illustrated-preset-options" aria-labelledby="illustrated-preset-label">
				{editor.effect.presets.map((preset) => {
					const illustration = editor.effect.illustrations?.find(
						(item) => item.presetId === preset.id && item.presetVersion === preset.version,
					);
					const selected = editor.selectedPreset.id === preset.id;
					return (
						<button
							key={preset.id}
							type="button"
							aria-pressed={selected}
							disabled={editor.isBusy}
							onClick={() => editor.requestPreset(preset.id)}
						>
							{illustration && (
								<Image
									src={illustration.image.src}
									alt=""
									width={80}
									height={100}
									sizes="80px"
									loading="eager"
								/>
							)}
							<span>{preset.name}</span>
							<CheckIcon size={16} aria-hidden="true" className={selected ? "is-selected" : ""} />
						</button>
					);
				})}
			</fieldset>
			<p className="illustrated-preset-hint">{editor.selectedPreset.inputHint}</p>
		</div>
	);
}
