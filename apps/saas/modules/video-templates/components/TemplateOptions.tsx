"use client";

import {
	getVideoTemplate,
	isRapTemplate,
	RAP_TEMPLATE_STYLES,
	sourceTemplateOptionSets,
	type SourceTemplateChoices,
	type SourceTemplateKey,
} from "@repo/config/video-template-library";
import { useTranslations } from "next-intl";
import Image from "next/image";

import { TemplateSelect } from "./TemplateSelect";

// Display names only; provider routes and prices remain server-owned.
const modelLabels = {
	standard: "Seedance 2 Mini",
	fast: "Seedance 2 Fast",
	pro: "Seedance 2",
	ultra: "Seedance 2.5",
};

export function TemplateOptions({
	templateKey,
	value,
	onChange,
	disabled = false,
	section = "all",
}: {
	templateKey: SourceTemplateKey;
	value: SourceTemplateChoices;
	onChange: (value: SourceTemplateChoices) => void;
	disabled?: boolean;
	section?: "all" | "cast" | "settings";
}) {
	const t = useTranslations("videoTemplates");
	const options = sourceTemplateOptionSets(templateKey, value);
	const rap = isRapTemplate(templateKey);
	function patch(change: Partial<SourceTemplateChoices>) {
		const next = { ...value, ...change };
		if (change.preset && templateKey === "spin-me-round")
			next.durationSeconds = change.preset === "trio" ? 15 : 12;
		const allowed = sourceTemplateOptionSets(templateKey, next);
		if (next.resolution && !allowed.resolutions.includes(next.resolution))
			next.resolution = allowed.resolutions[0];
		if (next.aspectRatio && !allowed.ratios.includes(next.aspectRatio))
			next.aspectRatio = allowed.ratios[0];
		onChange(next);
	}
	const formatSettings = (
		<>
			{options.tiers.length > 1 && (
				<TemplateSelect
					id="vt-model"
					label={t("model")}
					value={value.tier}
					disabled={disabled}
					items={options.tiers.map((tier) => ({ value: tier, label: modelLabels[tier] }))}
					onChange={(tier) => patch({ tier })}
				/>
			)}
			<div className="vt-settings-grid">
				{options.durations.length > 1 ? (
					<TemplateSelect
						id="vt-duration"
						label={t("duration")}
						value={value.durationSeconds}
						disabled={disabled}
						items={options.durations.map((duration) => ({
							value: duration,
							label: t("seconds", { count: duration }),
						}))}
						onChange={(durationSeconds) => patch({ durationSeconds })}
					/>
				) : (
					<div className="vt-field">
						<span id="vt-duration-label">{t("duration")}</span>
						<output className="vt-static-option" aria-labelledby="vt-duration-label">
							{value.durationSeconds
								? t("seconds", { count: value.durationSeconds })
								: t("templateDuration")}
						</output>
					</div>
				)}
				{options.resolutions.length > 0 &&
					(options.resolutions.length > 1 ? (
						<TemplateSelect
							id="vt-resolution"
							label={t("resolution")}
							value={value.resolution}
							disabled={disabled}
							items={options.resolutions.map((resolution) => ({
								value: resolution,
								label: resolution,
							}))}
							onChange={(resolution) => patch({ resolution })}
						/>
					) : (
						<div className="vt-field">
							<span id="vt-resolution-label">{t("resolution")}</span>
							<output className="vt-static-option" aria-labelledby="vt-resolution-label">
								{value.resolution}
							</output>
						</div>
					))}
				{options.ratios.length > 1 ? (
					<TemplateSelect
						id="vt-ratio"
						label={t("ratio")}
						value={value.aspectRatio}
						disabled={disabled}
						items={options.ratios.map((ratio) => ({
							value: ratio,
							label: ratio === "adaptive" ? t("adaptive") : ratio,
						}))}
						onChange={(aspectRatio) => patch({ aspectRatio })}
					/>
				) : (
					<div className="vt-field">
						<span id="vt-ratio-label">{t("ratio")}</span>
						<output className="vt-static-option" aria-labelledby="vt-ratio-label">
							{value.aspectRatio === "adaptive" ? t("adaptive") : value.aspectRatio}
						</output>
					</div>
				)}
			</div>
		</>
	);
	return (
		<fieldset className="vt-options" disabled={disabled}>
			{section !== "settings" && (
				<>
					{rap && templateKey === "original-rap" && (
						<fieldset className="vt-choice-group">
							<legend>{t("style")}</legend>
							<div className="vt-scenes">
								{RAP_TEMPLATE_STYLES.map((style) => (
									<button
										type="button"
										key={style}
										aria-pressed={value.stageId === style}
										onClick={() =>
											patch({ stageId: style, preset: style === "neon-rap" ? "solo" : "duo" })
										}
									>
										<Image
											src={getVideoTemplate(`rap-${style}`)!.sample!.poster}
											alt=""
											width={160}
											height={120}
										/>
										<span>{t(`styles.${style}`)}</span>
									</button>
								))}
							</div>
						</fieldset>
					)}
					{options.presets.length > 1 && (
						<fieldset className="vt-choice-group">
							<legend>{t("mode")}</legend>
							<div className="vt-segments">
								{options.presets.map((preset) => (
									<button
										type="button"
										key={preset}
										aria-pressed={value.preset === preset}
										onClick={() => patch({ preset })}
									>
										{t(`presets.${preset}`)}
									</button>
								))}
							</div>
						</fieldset>
					)}
					{templateKey === "spin-me-round" && (
						<fieldset className="vt-choice-group">
							<legend>{t("scene")}</legend>
							<div className="vt-segments">
								{(["empty-room", "retro-neon"] as const).map((sceneId) => (
									<button
										type="button"
										key={sceneId}
										aria-pressed={value.sceneId === sceneId}
										onClick={() => patch({ sceneId })}
									>
										{t(`scenes.${sceneId}`)}
									</button>
								))}
							</div>
						</fieldset>
					)}
				</>
			)}
			{section !== "cast" && (
				<>
					{rap && (
						<div className="vt-field">
							<label htmlFor="vt-direction">{t("direction")}</label>
							<textarea
								id="vt-direction"
								value={value.direction ?? ""}
								maxLength={2000}
								rows={2}
								onChange={(event) => patch({ direction: event.target.value })}
								placeholder={t("directionPlaceholder")}
								data-clarity-mask="true"
							/>
						</div>
					)}
					{rap && (value.occasion || value.customStage) && (
						<details className="vt-settings-details">
							<summary>{t("savedDetails")}</summary>
							<div>
								<p className="vt-help" data-clarity-mask="true">
									{[value.occasion, value.customStage].filter(Boolean).join(" · ")}
								</p>
								<button
									type="button"
									className="vt-text-button"
									onClick={() => patch({ occasion: "", customStage: "" })}
								>
									{t("clearSavedDetails")}
								</button>
							</div>
						</details>
					)}
					{options.tiers.length > 1 ? (
						<details className="vt-settings-details vt-video-settings">
							<summary aria-label={t("settingsSummary")}>
								<strong>{value.tier ? modelLabels[value.tier] : t("model")}</strong>
								<span>
									{value.durationSeconds
										? t("seconds", { count: value.durationSeconds })
										: t("templateDuration")}{" "}
									· {value.resolution} ·{" "}
									{value.aspectRatio === "adaptive" ? t("adaptive") : value.aspectRatio}
								</span>
							</summary>
							<div>{formatSettings}</div>
						</details>
					) : (
						formatSettings
					)}
				</>
			)}
		</fieldset>
	);
}
