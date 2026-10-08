"use client";

import { useGenerationMode } from "@media/lib/generation-mode-context";
import {
	getVideoModel,
	getVideoModelOptions,
	getVideoVariantGroup,
	VIDEO_MODEL_CATALOG,
	type VideoModelOption,
} from "@repo/config/video-models";
import type { VideoRetailDisplay } from "@repo/config/video-pricing.server";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover";
import {
	CheckIcon,
	ChevronDownIcon,
	Clock3Icon,
	LayersIcon,
	SlidersHorizontalIcon,
	Volume2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import {
	changeVideoDraft,
	summarizeVideoDurations,
	videoSelectionPricing,
	videoVariantControls,
	type VideoDraft,
} from "./model";
import { VideoModelIcon } from "./VideoModelIcon";
import { VideoAnnualBadge } from "./VideoRetailPrice";

type Availability = {
	productKey: string;
	available: boolean;
	options: readonly (Omit<VideoModelOption, "aspectRatio"> & {
		mode: VideoDraft["mode"];
		available: boolean;
		credits: string | null;
		pricing?: VideoRetailDisplay | null;
	})[];
};
const families = [...new Set(VIDEO_MODEL_CATALOG.map((model) => model.family))];

export function VideoSettings({
	draft,
	models,
	onChange,
	disabled,
	preview = false,
}: {
	draft: VideoDraft;
	models: readonly Availability[];
	onChange: (patch: Partial<VideoDraft>) => void;
	disabled: boolean;
	preview?: boolean;
}) {
	const t = useTranslations("videoV1");
	const model = getVideoModel(draft.productKey)!;
	const variantControls = videoVariantControls(draft, { accessAllowed: !preview, models });
	const modelLabel =
		variantControls?.group.label ??
		(draft.productKey === "video-veo-3-1-fast" ? t("legacyVeoFast") : model.label);
	const [modelsOpen, setModelsOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const active = useGenerationMode()?.mode !== "image";
	useEffect(() => {
		if (!active) {
			setModelsOpen(false);
			setSettingsOpen(false);
		}
	}, [active]);
	const [family, setFamily] = useState(model.family);
	const options = getVideoModelOptions(draft.productKey, draft.mode);
	const availability = models.find((entry) => entry.productKey === draft.productKey);
	const resolutionOptions = options.filter((option) => option.duration === draft.duration);
	const ratioOptions = resolutionOptions.filter((option) => option.resolution === draft.resolution);
	const isAvailable = (patch: Partial<VideoModelOption>) =>
		preview ||
		availability?.options.some(
			(option) =>
				option.mode === draft.mode &&
				option.veoTier === draft.veoTier &&
				option.available &&
				Object.entries(patch).every(
					([key, value]) => key === "aspectRatio" || option[key as keyof typeof option] === value,
				),
		) === true;
	const labelRatio = (ratio: string) =>
		ratio === "source" ? t("sourceRatio") : ratio === "adaptive" ? t("adaptiveRatio") : ratio;
	return (
		<>
			<Popover
				open={modelsOpen && !disabled && active}
				onOpenChange={(open) => {
					setModelsOpen(open);
					if (open) setFamily(model.family);
				}}
			>
				<PopoverTrigger
					render={
						<button
							type="button"
							id="video-model"
							aria-label={t("model")}
							data-product-key={draft.productKey}
							disabled={disabled}
							className="video-tool video-model-trigger"
						>
							<VideoModelIcon family={model.family} size={18} />
							<span>{modelLabel}</span>
							<ChevronDownIcon aria-hidden size={14} />
						</button>
					}
				/>
				<PopoverContent
					align="start"
					side="top"
					sideOffset={10}
					aria-label={t("model")}
					data-test="video-model-menu"
					className="video-popover video-model-menu"
				>
					<fieldset className="video-model-families" aria-label={t("modelFamilies")}>
						<p className="video-menu-label">{t("model")}</p>
						{families.map((name) => (
							<button
								type="button"
								key={name}
								aria-pressed={family === name}
								className="video-family"
								onClick={() => setFamily(name)}
							>
								<VideoModelIcon family={name} size={22} />
								{name}
							</button>
						))}
					</fieldset>
					<fieldset className="video-model-list" aria-label={family}>
						{VIDEO_MODEL_CATALOG.filter(
							(entry) =>
								entry.family === family &&
								(!getVideoVariantGroup(entry.productKey) ||
									getVideoVariantGroup(entry.productKey)!.productKey === entry.productKey),
						).map((entry) => {
							const group = getVideoVariantGroup(entry.productKey);
							const keys = group
								? [...new Set(group.variants.map((variant) => variant.selection.productKey))]
								: [entry.productKey];
							const selected = keys.includes(draft.productKey);
							const label =
								group?.label ??
								(entry.productKey === "video-veo-3-1-fast" ? t("legacyVeoFast") : entry.label);
							const available = models.some(
								(item) => keys.includes(item.productKey) && item.available,
							);
							const blocked = entry.status !== "implemented";
							const groups = keys.flatMap((key) => getVideoModel(key)!.groups);
							const durations = groups.flatMap((group) => group.durations);
							const durationSummary = summarizeVideoDurations(durations);
							const resolutions = [...new Set(groups.flatMap((group) => group.resolutions))];
							const candidate = selected
								? draft
								: changeVideoDraft(
										draft,
										{ productKey: entry.productKey },
										{ accessAllowed: !preview, models },
									);
							const pricing =
								!blocked && available && keys.includes(candidate.productKey)
									? videoSelectionPricing(candidate, { accessAllowed: !preview, models })
									: null;
							return (
								<button
									key={entry.productKey}
									type="button"
									aria-label={label}
									aria-pressed={selected}
									disabled={disabled || blocked || (!preview && !available)}
									className="video-model-option"
									onClick={() => {
										onChange({ productKey: entry.productKey });
										setModelsOpen(false);
									}}
								>
									<span className="video-model-name">
										<VideoModelIcon family={entry.family} size={18} />
										{label}
										<VideoAnnualBadge pricing={pricing} />
										{selected && <CheckIcon aria-hidden size={16} />}
									</span>
									{blocked || (!preview && !available) ? (
										<span className="video-model-capability">{t("unavailableShort")}</span>
									) : (
										<>
											<span className="video-model-capability">
												{entry.modes
													.map((mode) => t(mode === "text-to-video" ? "textMode" : "imageMode"))
													.join(" · ")}
											</span>
											<span className="video-model-capability">
												{resolutions
													.map((resolution) =>
														resolution === "default" ? t("modelDefault") : resolution.toUpperCase(),
													)
													.join(" / ")}
												<span aria-hidden> · </span>
												{durationSummary.kind === "range"
													? t("durationRange", {
															min: durationSummary.min,
															max: durationSummary.max,
														})
													: durationSummary.values
															.map((seconds) => t("seconds", { seconds }))
															.join(" / ")}
											</span>
											<span className="video-model-capability">
												{t(
													entry.audio === "provider-native"
														? "nativeSound"
														: entry.audio === "silent"
															? "soundOff"
															: "soundOptional",
												)}
											</span>
										</>
									)}
								</button>
							);
						})}
						<p className="video-menu-hint">{t("modelAvailabilityHint")}</p>
					</fieldset>
				</PopoverContent>
			</Popover>
			<Popover open={settingsOpen && !disabled && active} onOpenChange={setSettingsOpen}>
				<PopoverTrigger
					render={
						<button
							type="button"
							aria-label={t("settings")}
							disabled={disabled}
							data-test="video-settings-trigger"
							className="video-tool video-settings-trigger"
						>
							<SlidersHorizontalIcon aria-hidden size={15} />
							<span>{labelRatio(draft.aspectRatio)}</span>
							<span className="video-tool-divider" aria-hidden />
							<Clock3Icon aria-hidden size={13} />
							<span>{draft.duration}s</span>
							<span className="video-tool-divider" aria-hidden />
							<span>
								{draft.resolution === "default"
									? t("modelDefault")
									: draft.resolution.toUpperCase()}
							</span>
							<LayersIcon aria-hidden size={13} />
							<span>1</span>
							<ChevronDownIcon aria-hidden size={14} />
						</button>
					}
				/>
				<PopoverContent
					align="start"
					side="top"
					sideOffset={10}
					aria-label={t("settings")}
					data-test="video-settings-menu"
					className="video-popover video-settings-menu"
				>
					<h3>{t("settings")}</h3>
					<ChoiceGroup
						name="video-ratio"
						label={t("aspectRatio")}
						value={draft.aspectRatio}
						disabled={disabled}
						options={[...new Set(ratioOptions.map((option) => option.aspectRatio))].map(
							(ratio) => ({
								value: ratio,
								label: labelRatio(ratio),
								ratio,
								disabled: !isAvailable({ duration: draft.duration, resolution: draft.resolution }),
							}),
						)}
						onChange={(aspectRatio) => onChange({ aspectRatio })}
					/>
					{draft.aspectRatio === "source" && <p className="video-menu-hint">{t("imageRatio")}</p>}
					<ChoiceGroup
						name="video-duration"
						label={t("duration")}
						value={String(draft.duration)}
						disabled={disabled}
						options={[...new Set(options.map((option) => option.duration))].map((duration) => ({
							value: String(duration),
							label: t("seconds", { seconds: duration }),
							compact: `${duration}s`,
							disabled: !isAvailable({ duration }),
						}))}
						onChange={(duration) => onChange({ duration: Number(duration) })}
					/>
					<ChoiceGroup
						name="video-resolution"
						label={t("resolution")}
						value={draft.resolution}
						disabled={disabled}
						options={[...new Set(resolutionOptions.map((option) => option.resolution))].map(
							(resolution) => ({
								value: resolution,
								label: resolution === "default" ? t("modelDefault") : resolution.toUpperCase(),
								disabled: !isAvailable({ duration: draft.duration, resolution }),
							}),
						)}
						onChange={(resolution) => onChange({ resolution })}
					/>
					<ChoiceGroup
						name="video-count"
						label={t("quantity")}
						value="1"
						disabled
						options={[{ value: "1", label: t("oneVideo") }]}
						onChange={() => {}}
					/>
					<button type="button" className="video-done" onClick={() => setSettingsOpen(false)}>
						{t("done")}
					</button>
				</PopoverContent>
			</Popover>
			{model.audio === "toggle" ? (
				<button
					type="button"
					role="switch"
					aria-label={t("sound")}
					aria-checked={draft.sound}
					className="video-tool video-sound"
					disabled={
						disabled ||
						!isAvailable({
							duration: draft.duration,
							resolution: draft.resolution,
							sound: !draft.sound,
						})
					}
					onClick={() => onChange({ sound: !draft.sound })}
				>
					<Volume2Icon aria-hidden size={15} />
					<span>{t(draft.sound ? "soundOn" : "soundOff")}</span>
					<span className="video-switch" data-checked={draft.sound} aria-hidden />
				</button>
			) : (
				<span
					className="video-audio-note"
					title={model.audio === "provider-native" ? t("nativeSoundHint") : undefined}
				>
					<Volume2Icon aria-hidden size={14} />
					{t(model.audio === "provider-native" ? "nativeSound" : "soundOff")}
				</span>
			)}
			{variantControls && (
				<fieldset className="video-variants" aria-label={t("variant")} disabled={disabled}>
					<legend className="sr-only">{t("variant")}</legend>
					<span
						className="video-variant-summary"
						title={t("variantHelp", { variant: variantControls.base.label })}
					>
						{t("currentVariant", { variant: variantControls.current?.label ?? modelLabel })}
						<small>{t("baseVariant", { variant: variantControls.base.label })}</small>
					</span>
					{variantControls.alternatives.map((variant) => (
						<button
							key={variant.id}
							type="button"
							className="video-tool video-variant"
							aria-label={variant.label}
							aria-pressed={variant.pressed}
							disabled={disabled || (!preview && variant.credits === null)}
							onClick={() => onChange(variant.patch)}
						>
							{variant.label}
						</button>
					))}
				</fieldset>
			)}
		</>
	);
}

function ChoiceGroup({
	name,
	label,
	value,
	options,
	onChange,
	disabled,
}: {
	name: string;
	label: string;
	value: string;
	disabled?: boolean;
	onChange: (value: string) => void;
	options: { value: string; label: string; compact?: string; ratio?: string; disabled?: boolean }[];
}) {
	return (
		<fieldset className="video-setting" disabled={disabled}>
			<legend>{label}</legend>
			<div className="video-choices">
				{options.map((option) => {
					const ratio = option.ratio?.match(/^(\d+):(\d+)$/);
					const aspect = ratio ? Number(ratio[1]) / Number(ratio[2]) : 1;
					return (
						<label
							key={option.value}
							className="video-choice"
							data-disabled={disabled || option.disabled}
						>
							<input
								type="radio"
								name={name}
								value={option.value}
								aria-label={option.label}
								checked={value === option.value}
								disabled={option.disabled}
								onChange={() => onChange(option.value)}
							/>
							<span className="video-choice-content">
								{option.ratio && (
									<span
										aria-hidden
										className="video-ratio-shape"
										style={{
											width: `${aspect >= 1 ? 24 : 24 * aspect}px`,
											height: `${aspect <= 1 ? 24 : 24 / aspect}px`,
										}}
									/>
								)}
								{option.compact ?? option.label}
							</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}
