"use client";

import type { ImageAspectRatio } from "@repo/config/client";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover";
import { ChevronDownIcon, ImageIcon, ScanIcon, SlidersHorizontalIcon } from "lucide-react";
import { useId } from "react";

export interface ImageOutputSettingsLabels {
	title: string;
	trigger: string;
	aspectRatio: string;
	automatic: string;
	outputNumber: string;
	oneOutput: string;
	resolution: string;
	quality: string;
	modeControlsQuality: string;
}

export function ImageOutputSettings({
	idPrefix,
	aspectRatios,
	value,
	onChange,
	modeLabel,
	labels,
	disabled = false,
	tone = "dark",
}: {
	idPrefix: string;
	aspectRatios: readonly ImageAspectRatio[];
	value: ImageAspectRatio;
	onChange: (value: ImageAspectRatio) => void;
	modeLabel: string;
	labels: ImageOutputSettingsLabels;
	disabled?: boolean;
	tone?: "dark" | "light";
}) {
	const generatedId = useId();
	const groupName = `${idPrefix}-${generatedId}-aspect-ratio`;
	const currentLabel = value === "auto" ? labels.automatic : value;
	const dark = tone === "dark";

	return (
		<Popover>
			<PopoverTrigger
				render={
					<button
						type="button"
						data-test={`${idPrefix}-output-settings-trigger`}
						className={`min-h-11 gap-1.5 sm:gap-2 px-3 text-xs font-semibold focus-visible:outline-violet-300 flex w-full items-center rounded-xl border text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
							dark
								? "border-white/10 bg-[#1e1729] text-[#c5b9d2] hover:border-[#b79cff]/45 hover:bg-[#251c32]"
								: "border-foreground/10 bg-muted/45 text-muted-foreground hover:border-primary/35 hover:bg-muted"
						}`}
						disabled={disabled || aspectRatios.length === 0}
						aria-label={labels.trigger}
					>
						<SlidersHorizontalIcon className="size-4 shrink-0 text-[#b79cff]" aria-hidden="true" />
						<span className={`whitespace-nowrap ${dark ? "text-[#f2ecfa]" : "text-foreground"}`}>
							{labels.title}
						</span>
						<span className="h-4 w-px bg-current opacity-15" aria-hidden="true" />
						<span className="gap-1.5 flex items-center">
							<ScanIcon className="size-3.5" aria-hidden="true" />
							{currentLabel}
						</span>
						<span className="gap-1.5 flex items-center max-[359px]:hidden">
							<ImageIcon className="size-3.5" aria-hidden="true" />1
						</span>
						{!dark && <span className="sm:inline ml-auto hidden">{labels.automatic}</span>}
						<ChevronDownIcon
							className={`size-4 shrink-0 opacity-70 ${dark ? "ml-auto" : ""}`}
							aria-hidden="true"
						/>
					</button>
				}
			/>
			<PopoverContent
				align="start"
				side="bottom"
				sideOffset={8}
				className={`p-3 sm:p-4 max-h-[var(--available-height)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-2xl shadow-[0_28px_70px_-24px_rgba(0,0,0,0.8)] ${
					dark
						? "border-white/10 bg-[#2a2037] text-[#f2ecfa]"
						: "border-foreground/10 bg-popover text-popover-foreground"
				}`}
			>
				<div className="gap-2 flex items-center">
					<SlidersHorizontalIcon className="size-4 text-[#b79cff]" aria-hidden="true" />
					<h3 className="text-sm font-semibold">{labels.title}</h3>
				</div>
				<fieldset className="mt-4">
					<legend
						className={`text-xs font-semibold ${dark ? "text-[#c5b9d2]" : "text-muted-foreground"}`}
					>
						{labels.aspectRatio}
					</legend>
					<div className="mt-2 gap-2 sm:grid-cols-5 grid grid-cols-3">
						{aspectRatios.map((aspectRatio) => {
							const selected = aspectRatio === value;
							return (
								<label
									key={aspectRatio}
									className={`min-h-10 px-2 text-xs font-semibold focus-within:outline-violet-300 flex cursor-pointer items-center justify-center rounded-lg border transition focus-within:outline-2 focus-within:outline-offset-2 ${
										selected
											? dark
												? "text-white border-[#b79cff]/70 bg-[#4b3a70]"
												: "border-primary/50 bg-primary/10 text-foreground"
											: dark
												? "border-white/10 bg-[#1e1729] text-[#c5b9d2] hover:border-[#b79cff]/40"
												: "border-foreground/10 bg-background text-muted-foreground hover:border-primary/30"
									}`}
								>
									<input
										type="radio"
										name={groupName}
										value={aspectRatio}
										checked={selected}
										className="sr-only"
										onChange={() => onChange(aspectRatio)}
									/>
									{aspectRatio === "auto" ? labels.automatic : aspectRatio}
								</label>
							);
						})}
					</div>
				</fieldset>

				<dl
					className={`mt-4 gap-2 pt-3 grid grid-cols-3 border-t ${dark ? "border-white/10" : "border-foreground/10"}`}
				>
					<ReadOnlySetting
						label={labels.outputNumber}
						value="1"
						hint={labels.oneOutput}
						dark={dark}
					/>
					<ReadOnlySetting label={labels.resolution} value={labels.automatic} dark={dark} />
					<ReadOnlySetting
						label={labels.quality}
						value={modeLabel}
						hint={labels.modeControlsQuality}
						dark={dark}
					/>
				</dl>
			</PopoverContent>
		</Popover>
	);
}

function ReadOnlySetting({
	label,
	value,
	hint,
	dark,
}: {
	label: string;
	value: string;
	hint?: string;
	dark: boolean;
}) {
	return (
		<div className={`min-w-0 p-3 rounded-xl ${dark ? "bg-[#1e1729]" : "bg-muted/45"}`}>
			<dt
				className={`font-semibold text-[0.68rem] ${dark ? "text-[#978aa5]" : "text-muted-foreground"}`}
			>
				{label}
			</dt>
			<dd
				className={`mt-1 sm:text-sm font-semibold leading-4 text-[0.7rem] ${dark ? "text-[#f2ecfa]" : "text-foreground"}`}
			>
				{value}
			</dd>
			{hint ? (
				<p
					className={`mt-1 leading-4 sm:block hidden text-[0.65rem] ${dark ? "text-[#978aa5]" : "text-muted-foreground"}`}
				>
					{hint}
				</p>
			) : null}
		</div>
	);
}
