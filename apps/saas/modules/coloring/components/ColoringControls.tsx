"use client";

import { useToolPrompt } from "@media/lib/tool-prompt-context";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
	buildColoringPrompt,
	COLORING_DETAILS,
	type ColoringBackground,
	type ColoringDetail,
} from "../lib/coloring-prompt";

export function ColoringControls() {
	const t = useTranslations("coloring");
	const editor = useToolPrompt();
	const [detail, setDetail] = useState<ColoringDetail>("balanced");
	const [background, setBackground] = useState<ColoringBackground>("remove");
	const [appliedPrompt, setAppliedPrompt] = useState<string | null>(null);
	const prompt = buildColoringPrompt(detail, background);
	return (
		<div className="coloring-controls">
			<fieldset disabled={editor?.busy}>
				<legend>{t("detail")}</legend>
				<div className="coloring-detail-options">
					{COLORING_DETAILS.map((value) => (
						<label key={value}>
							<input
								type="radio"
								name="coloring-detail"
								value={value}
								checked={detail === value}
								onChange={() => setDetail(value)}
							/>
							<span>{t(`levels.${value}`)}</span>
						</label>
					))}
				</div>
			</fieldset>
			<div className="coloring-background">
				<label htmlFor="coloring-background">{t("background")}</label>
				<select
					id="coloring-background"
					value={background}
					disabled={editor?.busy}
					onChange={(event) => setBackground(event.target.value as ColoringBackground)}
				>
					<option value="remove">{t("removeBackground")}</option>
					<option value="keep">{t("keepBackground")}</option>
				</select>
			</div>
			<button
				className="coloring-apply"
				type="button"
				disabled={!editor?.ready || editor.busy}
				onClick={() => {
					if (editor?.apply(prompt)) setAppliedPrompt(prompt);
				}}
			>
				{t("apply")}
			</button>
			<p className="coloring-control-note">{t("applyHint")}</p>
			<output aria-live="polite">
				{appliedPrompt === prompt && editor?.prompt === prompt ? t("applied") : ""}
			</output>
		</div>
	);
}
