"use client";

import {
	getVideoModel,
	getVideoModelOptions,
	VIDEO_MODEL_CATALOG,
	type VideoModelOption,
} from "@repo/config/video-models";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover";
import { CheckIcon, ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { VideoDraft } from "./model";

type Availability = {
	productKey: string;
	available: boolean;
	options: readonly (Omit<VideoModelOption, "aspectRatio"> & {
		mode: VideoDraft["mode"];
		available: boolean;
		credits: string | null;
	})[];
};
const families = ["MiniMax", "Seedance", "Gemini", "Kling", "Veo"] as const;
const selectStyle = "h-11 px-3 w-full rounded-lg border bg-background";

export function VideoSettings({
	draft,
	models,
	onChange,
	disabled,
}: {
	draft: VideoDraft;
	models: readonly Availability[];
	onChange: (patch: Partial<VideoDraft>) => void;
	disabled: boolean;
}) {
	const t = useTranslations("videoV1");
	const [modelsOpen, setModelsOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const model = getVideoModel(draft.productKey)!;
	const options = getVideoModelOptions(draft.productKey, draft.mode);
	const availability = models.find((entry) => entry.productKey === draft.productKey);
	const durationOptions = options;
	const resolutionOptions = options.filter((option) => option.duration === draft.duration);
	const ratioOptions = resolutionOptions.filter((option) => option.resolution === draft.resolution);
	const soundOptions = ratioOptions.filter((option) => option.aspectRatio === draft.aspectRatio);
	const isAvailable = (patch: Partial<VideoModelOption>) =>
		availability?.options.some(
			(option) =>
				option.mode === draft.mode &&
				option.available &&
				Object.entries(patch).every(
					([key, value]) => key === "aspectRatio" || option[key as keyof typeof option] === value,
				),
		) === true;
	const suffix = (available: boolean) => (available ? "" : ` · ${t("unavailableShort")}`);
	const sourceRatio =
		draft.aspectRatio === "source" &&
		new Set(ratioOptions.map((option) => option.aspectRatio)).size === 1;
	return (
		<>
			<div className="space-y-2">
				<p className="text-sm font-medium">{t("model")}</p>
				<Popover open={modelsOpen} onOpenChange={setModelsOpen}>
					<PopoverTrigger
						render={
							<button
								type="button"
								id="video-model"
								aria-label={t("model")}
								data-product-key={draft.productKey}
								disabled={disabled}
								className={`${selectStyle} text-sm flex items-center justify-between text-left`}
							>
								<span>{model.label}</span>
								<ChevronDownIcon aria-hidden className="size-4 shrink-0" />
							</button>
						}
					/>
					<PopoverContent
						align="start"
						side="bottom"
						sideOffset={8}
						aria-label={t("model")}
						data-test="video-model-menu"
						className="studio-theme p-4 shadow-xl max-h-[min(36rem,var(--available-height))] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl bg-card text-card-foreground"
					>
						<div className="gap-4 sm:grid-cols-2 grid">
							{families.map((family) => (
								<section key={family} aria-label={family} className="space-y-1">
									<h3 className="px-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
										{family}
									</h3>
									{VIDEO_MODEL_CATALOG.filter((entry) => entry.family === family).map((entry) => {
										const selected = entry.productKey === draft.productKey;
										const available =
											models.find((item) => item.productKey === entry.productKey)?.available ===
											true;
										return (
											<button
												key={entry.productKey}
												type="button"
												aria-label={entry.label}
												aria-pressed={selected}
												disabled={disabled || entry.status === "blocked"}
												className={`min-h-11 gap-2 px-3 py-2 text-sm flex w-full items-center justify-between rounded-xl text-left transition focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45 ${selected ? "bg-primary/10 text-primary ring-1 ring-primary/30" : "hover:bg-muted"}`}
												onClick={() => {
													onChange({ productKey: entry.productKey });
													setModelsOpen(false);
												}}
											>
												<span>
													{entry.label}
													{!available && (
														<span className="mt-0.5 text-xs block text-muted-foreground">
															{t("unavailableShort")}
														</span>
													)}
												</span>
												{selected && <CheckIcon aria-hidden className="size-4 shrink-0" />}
											</button>
										);
									})}
								</section>
							))}
						</div>
					</PopoverContent>
				</Popover>
				<p className="text-xs text-muted-foreground">{t("modelAvailabilityHint")}</p>
			</div>
			<div className="space-y-2">
				<label htmlFor="video-mode" className="text-sm font-medium">
					{t("mode")}
				</label>
				<select
					id="video-mode"
					className={selectStyle}
					value={draft.mode}
					onChange={(event) => onChange({ mode: event.target.value as VideoDraft["mode"] })}
				>
					{model.modes.map((mode) => (
						<option key={mode} value={mode}>
							{t(mode === "text-to-video" ? "textMode" : "imageMode")}
						</option>
					))}
				</select>
			</div>
			<Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
				<PopoverTrigger
					render={
						<button
							type="button"
							aria-label={t("settings")}
							disabled={disabled}
							data-test="video-settings-trigger"
							className="min-h-11 gap-2 px-3 py-2 text-xs font-medium flex w-full flex-wrap items-center rounded-xl border bg-muted/30 text-left"
						>
							<SlidersHorizontalIcon aria-hidden className="size-4 shrink-0" />
							<span>{t("seconds", { seconds: draft.duration })}</span>
							<span aria-hidden>·</span>
							<span>
								{draft.resolution === "default"
									? t("modelDefault")
									: draft.resolution.toUpperCase()}
							</span>
							<span aria-hidden>·</span>
							<span>
								{draft.aspectRatio === "source"
									? t("sourceRatio")
									: draft.aspectRatio === "adaptive"
										? t("adaptiveRatio")
										: draft.aspectRatio}
							</span>
							<span aria-hidden>·</span>
							<span>
								{t(
									model.audio === "provider-native"
										? "nativeSound"
										: draft.sound
											? "soundOn"
											: "soundOff",
								)}
							</span>
							<ChevronDownIcon aria-hidden className="size-4 ml-auto shrink-0" />
						</button>
					}
				/>
				<PopoverContent
					align="start"
					side="bottom"
					sideOffset={8}
					aria-label={t("settings")}
					data-test="video-settings-menu"
					className="studio-theme space-y-4 p-4 shadow-xl max-h-[var(--available-height)] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border bg-card text-card-foreground"
				>
					<h3 className="text-sm font-semibold">{t("settings")}</h3>
					<fieldset disabled={disabled} className="gap-3 grid grid-cols-2">
						<legend className="sr-only">{t("settings")}</legend>
						<div className="space-y-2">
							<label htmlFor="video-duration" className="text-sm font-medium">
								{t("duration")}
							</label>
							<select
								id="video-duration"
								className={selectStyle}
								value={draft.duration}
								onChange={(event) => onChange({ duration: Number(event.target.value) })}
							>
								{[...new Set(durationOptions.map((option) => option.duration))].map((duration) => {
									const available = isAvailable({ duration });
									return (
										<option key={duration} value={duration} disabled={!available}>
											{t("seconds", { seconds: duration })}
											{suffix(available)}
										</option>
									);
								})}
							</select>
						</div>
						<div className="space-y-2">
							<label htmlFor="video-resolution" className="text-sm font-medium">
								{t("resolution")}
							</label>
							<select
								id="video-resolution"
								className={selectStyle}
								value={draft.resolution}
								onChange={(event) => onChange({ resolution: event.target.value })}
							>
								{[...new Set(resolutionOptions.map((option) => option.resolution))].map(
									(resolution) => {
										const available = isAvailable({ duration: draft.duration, resolution });
										return (
											<option key={resolution} value={resolution} disabled={!available}>
												{resolution === "default" ? t("modelDefault") : resolution.toUpperCase()}
												{suffix(available)}
											</option>
										);
									},
								)}
							</select>
						</div>
						{!sourceRatio && (
							<div className="space-y-2">
								<label htmlFor="video-ratio" className="text-sm font-medium">
									{t("aspectRatio")}
								</label>
								<select
									id="video-ratio"
									className={selectStyle}
									value={draft.aspectRatio}
									onChange={(event) => onChange({ aspectRatio: event.target.value })}
								>
									{[...new Set(ratioOptions.map((option) => option.aspectRatio))].map(
										(aspectRatio) => {
											const available = isAvailable({
												duration: draft.duration,
												resolution: draft.resolution,
												aspectRatio,
											});
											return (
												<option key={aspectRatio} value={aspectRatio} disabled={!available}>
													{aspectRatio === "source"
														? t("sourceRatio")
														: aspectRatio === "adaptive"
															? t("adaptiveRatio")
															: aspectRatio}
													{suffix(available)}
												</option>
											);
										},
									)}
								</select>
							</div>
						)}
						<div className="space-y-2">
							<label htmlFor="video-sound" className="text-sm font-medium">
								{t("sound")}
							</label>
							<select
								id="video-sound"
								className={selectStyle}
								value={String(draft.sound)}
								onChange={(event) => onChange({ sound: event.target.value === "true" })}
							>
								{[...new Set(soundOptions.map((option) => option.sound))].map((sound) => {
									const available = isAvailable({
										duration: draft.duration,
										resolution: draft.resolution,
										aspectRatio: draft.aspectRatio,
										sound,
									});
									return (
										<option key={String(sound)} value={String(sound)} disabled={!available}>
											{t(
												model.audio === "provider-native"
													? "nativeSound"
													: sound
														? "soundOn"
														: "soundOff",
											)}
											{suffix(available)}
										</option>
									);
								})}
							</select>
						</div>
					</fieldset>
					<button
						type="button"
						className="min-h-10 px-3 text-sm font-semibold w-full rounded-lg bg-primary/10 text-primary"
						onClick={() => setSettingsOpen(false)}
					>
						{t("done")}
					</button>
				</PopoverContent>
			</Popover>
			{sourceRatio && <p className="text-xs text-muted-foreground">{t("imageRatio")}</p>}
			{model.audio === "provider-native" && (
				<p className="text-xs text-muted-foreground">{t("nativeSoundHint")}</p>
			)}
		</>
	);
}
