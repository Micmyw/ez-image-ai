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
	const settings = (
		<>
			{options.tiers.length > 0 && (
				<div className="vt-field">
					<label htmlFor="vt-tier">{t("tier")}</label>
					<select
						id="vt-tier"
						value={value.tier}
						onChange={(event) =>
							patch({ tier: event.target.value as SourceTemplateChoices["tier"] })
						}
					>
						{options.tiers.map((tier) => (
							<option value={tier} key={tier}>
								{t(`tiers.${tier}`)}
							</option>
						))}
					</select>
				</div>
			)}
			<div className="vt-settings-grid">
				<div className="vt-field">
					<label
						id="vt-duration-label"
						htmlFor={options.durations.length > 1 ? "vt-duration" : undefined}
					>
						{t("duration")}
					</label>
					{options.durations.length > 1 ? (
						<select
							id="vt-duration"
							value={value.durationSeconds}
							onChange={(event) =>
								patch({
									durationSeconds: Number(
										event.target.value,
									) as SourceTemplateChoices["durationSeconds"],
								})
							}
						>
							{options.durations.map((duration) => (
								<option value={duration} key={duration}>
									{t("seconds", { count: duration })}
								</option>
							))}
						</select>
					) : (
						<output className="vt-static-option" aria-labelledby="vt-duration-label">
							{value.durationSeconds
								? t("seconds", { count: value.durationSeconds })
								: t("templateDuration")}
						</output>
					)}
				</div>
				{options.resolutions.length > 0 && (
					<div className="vt-field">
						<label
							id="vt-resolution-label"
							htmlFor={options.resolutions.length > 1 ? "vt-resolution" : undefined}
						>
							{t("resolution")}
						</label>
						{options.resolutions.length > 1 ? (
							<select
								id="vt-resolution"
								value={value.resolution}
								onChange={(event) =>
									patch({ resolution: event.target.value as SourceTemplateChoices["resolution"] })
								}
							>
								{options.resolutions.map((resolution) => (
									<option value={resolution} key={resolution}>
										{resolution}
									</option>
								))}
							</select>
						) : (
							<output className="vt-static-option" aria-labelledby="vt-resolution-label">
								{value.resolution}
							</output>
						)}
					</div>
				)}
				<div className="vt-field">
					<label id="vt-ratio-label" htmlFor={options.ratios.length > 1 ? "vt-ratio" : undefined}>
						{t("ratio")}
					</label>
					{options.ratios.length > 1 ? (
						<select
							id="vt-ratio"
							value={value.aspectRatio}
							onChange={(event) =>
								patch({ aspectRatio: event.target.value as SourceTemplateChoices["aspectRatio"] })
							}
						>
							{options.ratios.map((ratio) => (
								<option value={ratio} key={ratio}>
									{ratio === "adaptive" ? t("adaptive") : ratio}
								</option>
							))}
						</select>
					) : (
						<output className="vt-static-option" aria-labelledby="vt-ratio-label">
							{value.aspectRatio === "adaptive" ? t("adaptive") : value.aspectRatio}
						</output>
					)}
				</div>
			</div>
			{rap && (
				<>
					<div className="vt-field">
						<label htmlFor="vt-language">{t("language")}</label>
						<select
							id="vt-language"
							value={value.locale}
							onChange={(event) =>
								patch({ locale: event.target.value as SourceTemplateChoices["locale"] })
							}
						>
							<option value="en">{t("languages.en")}</option>
							<option value="zh">{t("languages.zh")}</option>
						</select>
					</div>
					<div className="vt-field">
						<label htmlFor="vt-occasion">{t("occasion")}</label>
						<input
							id="vt-occasion"
							value={value.occasion ?? ""}
							maxLength={500}
							onChange={(event) => patch({ occasion: event.target.value })}
							data-clarity-mask="true"
						/>
					</div>
					<div className="vt-field">
						<label htmlFor="vt-custom-stage">{t("customStage")}</label>
						<textarea
							id="vt-custom-stage"
							value={value.customStage ?? ""}
							maxLength={2000}
							rows={2}
							onChange={(event) => patch({ customStage: event.target.value })}
							data-clarity-mask="true"
						/>
					</div>
				</>
			)}
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
											height={90}
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
								rows={3}
								onChange={(event) => patch({ direction: event.target.value })}
								aria-describedby="vt-direction-hint"
								data-clarity-mask="true"
							/>
							<p id="vt-direction-hint" className="vt-help">
								{t("directionHint")}
							</p>
						</div>
					)}
					{options.tiers.length > 0 ? (
						<details className="vt-settings-details">
							<summary>
								{t("moreSettings")}
								<span>
									{value.resolution} · {value.durationSeconds}s · {value.aspectRatio}
								</span>
							</summary>
							<div>{settings}</div>
						</details>
					) : (
						settings
					)}
				</>
			)}
		</fieldset>
	);
}
