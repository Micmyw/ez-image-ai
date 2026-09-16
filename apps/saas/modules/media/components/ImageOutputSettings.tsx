"use client";

import type { ImageAspectRatio } from "@repo/config/client";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover";
import { ChevronDownIcon, ImageIcon, ScanIcon, SlidersHorizontalIcon } from "lucide-react";
import { useId } from "react";

import {
	getImageSpecCell,
	type ImageSpecControlKey,
	type ImageSpecControlValues,
	type PublicImageSpecMatrix,
	selectImageSkuForDimension,
} from "../lib/image-sku-selection";

export interface ImageOutputSettingsLabels {
	title: string;
	trigger: string;
	aspectRatio: string;
	automatic: string;
	outputNumber: string;
	oneOutput: string;
	resolution: string;
	quality: string;
	outputFormat: string;
	background: string;
	modeControlsQuality: string;
	credits?: string;
	coupledHint?: string;
	optionLabels?: Readonly<Record<string, string>>;
}

export function ImageOutputSettings({
	idPrefix,
	aspectRatios,
	value,
	onChange,
	modeLabel,
	skuMatrix,
	skuKey,
	onSkuChange,
	controlValues = {},
	onControlChange,
	labels,
	disabled = false,
	tone = "dark",
}: {
	idPrefix: string;
	aspectRatios: readonly ImageAspectRatio[];
	value: ImageAspectRatio;
	onChange: (value: ImageAspectRatio) => void;
	modeLabel: string;
	skuMatrix?: PublicImageSpecMatrix;
	skuKey?: string;
	onSkuChange?: (skuKey: string) => void;
	controlValues?: ImageSpecControlValues;
	onControlChange?: (key: ImageSpecControlKey, value: string) => void;
	labels: ImageOutputSettingsLabels;
	disabled?: boolean;
	tone?: "dark" | "light";
}) {
	const generatedId = useId();
	const selectedCell = getImageSpecCell(skuMatrix, skuKey);
	const selectedOptions = (skuMatrix?.dimensions ?? []).flatMap((dimension) => {
		const option = dimension.options.find(
			(candidate) => candidate.key === selectedCell?.parameterValues[dimension.key],
		);
		return option
			? [{ key: dimension.key, label: labels.optionLabels?.[option.key] ?? option.label }]
			: [];
	});
	const selectionSummary = [
		value === "auto" ? labels.automatic : value,
		"1",
		...selectedOptions.map((option) => option.label),
	].join(", ");
	const dark = tone === "dark";
	const muted = dark ? "text-[#b2a7bc]" : "text-muted-foreground";
	const optionStyle = (selected: boolean) =>
		`min-h-11 min-w-0 rounded-lg px-2 py-1 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300 disabled:cursor-not-allowed disabled:opacity-45 ${selected ? (dark ? "bg-[#4b3a70] text-white" : "bg-primary/10 text-foreground ring-1 ring-primary/50") : dark ? "text-[#c5b9d2] hover:bg-white/5" : "text-muted-foreground hover:bg-muted"}`;
	const coupled =
		skuMatrix &&
		skuMatrix.dimensions.length > 1 &&
		skuMatrix.cells.length <
			skuMatrix.dimensions.reduce((count, dimension) => count * dimension.options.length, 1);

	return (
		<Popover>
			<PopoverTrigger
				render={
					<button
						type="button"
						data-test={`${idPrefix}-output-settings-trigger`}
						className={`min-h-11 gap-2 px-3 text-xs font-semibold focus-visible:outline-violet-300 inline-flex max-w-full items-center rounded-lg border whitespace-nowrap transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${dark ? "border-white/10 bg-white/[0.055] hover:bg-white/10 text-[#c5b9d2]" : "border-foreground/10 bg-muted/45 text-muted-foreground hover:bg-muted"}`}
						disabled={disabled || aspectRatios.length === 0}
						aria-label={`${labels.trigger}: ${selectionSummary}`}
					>
						<span className="gap-1.5 flex shrink-0 items-center">
							<ScanIcon className="size-3.5" aria-hidden="true" />
							<span className={value === "auto" ? "sr-only" : ""}>
								{value === "auto" ? labels.automatic : value}
							</span>
						</span>
						<span className="gap-1.5 pl-2 flex items-center border-l border-current/15 max-[359px]:hidden">
							<ImageIcon className="size-3.5" aria-hidden="true" />1
						</span>
						{selectedOptions.map((option) => (
							<span key={option.key} className="pl-2 border-l border-current/15">
								{option.label}
							</span>
						))}
						<ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
					</button>
				}
			/>
			<PopoverContent
				align="start"
				side="top"
				sticky
				sideOffset={8}
				positionerClassName="z-[80]"
				aria-label={labels.title}
				className={`p-3 sm:p-4 max-h-[var(--available-height)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-2xl shadow-[0_24px_64px_-16px_rgba(0,0,0,0.65)] ${dark ? "border-white/10 bg-[#2a2037] text-[#f2ecfa]" : "border-foreground/10 bg-popover text-popover-foreground"}`}
			>
				<div className="gap-2 flex items-center">
					<SlidersHorizontalIcon className="size-4 text-[#b79cff]" aria-hidden="true" />
					<h3 className="text-sm font-semibold">{labels.title}</h3>
				</div>
				<fieldset className="mt-4" disabled={disabled}>
					<legend className={`text-xs font-semibold ${muted}`}>{labels.aspectRatio}</legend>
					<div className="mt-2 gap-1 sm:grid-cols-6 grid grid-cols-4">
						{aspectRatios.map((aspectRatio) => {
							const selected = aspectRatio === value;
							const [width, height] =
								aspectRatio === "auto" ? [1, 1] : aspectRatio.split(":").map(Number);
							return (
								<label
									key={aspectRatio}
									className={`${optionStyle(selected)} min-h-14 gap-1 focus-within:outline-violet-300 relative flex cursor-pointer flex-col items-center justify-center focus-within:outline-2`}
								>
									<input
										type="radio"
										name={`${idPrefix}-${generatedId}-aspect-ratio`}
										value={aspectRatio}
										checked={selected}
										disabled={disabled}
										className="sr-only"
										onChange={() => onChange(aspectRatio)}
									/>
									<span className="h-6 grid place-items-center" aria-hidden="true">
										{aspectRatio === "auto" ? (
											<ScanIcon className="size-4" />
										) : (
											<span
												className="block rounded-[3px] border-[1.5px] border-current opacity-70"
												style={{
													width: Math.min(22, (16 * width!) / height!),
													height: Math.min(22, (16 * height!) / width!),
												}}
											/>
										)}
									</span>
									<span className="text-[0.65rem]">
										{aspectRatio === "auto" ? labels.automatic : aspectRatio}
									</span>
								</label>
							);
						})}
					</div>
				</fieldset>
				{skuMatrix?.dimensions.map((dimension) => (
					<fieldset key={dimension.key} className="mt-4">
						<legend className={`text-xs font-semibold ${muted}`}>{labels[dimension.key]}</legend>
						<div
							className={`mt-2 gap-1 p-1 grid auto-cols-fr grid-flow-col rounded-xl ${dark ? "bg-black/10" : "bg-muted/40"}`}
						>
							{dimension.options.map((option) => {
								const nextCell = skuKey
									? selectImageSkuForDimension(skuMatrix, skuKey, dimension.key, option.key)
									: null;
								const selected = selectedCell?.parameterValues[dimension.key] === option.key;
								return (
									<button
										key={option.key}
										type="button"
										aria-label={labels.optionLabels?.[option.key] ?? option.label}
										aria-pressed={selected}
										data-sku-key={nextCell?.skuKey}
										disabled={disabled || !nextCell || !onSkuChange}
										className={optionStyle(selected)}
										onClick={() => {
											if (nextCell) onSkuChange?.(nextCell.skuKey);
										}}
									>
										<span className="py-1 block">
											{labels.optionLabels?.[option.key] ?? option.label}
										</span>
										{nextCell && (
											<span className="pb-1 font-normal block text-[0.6rem] opacity-75">
												{nextCell.credits} {labels.credits ?? "Credits"}
											</span>
										)}
									</button>
								);
							})}
						</div>
					</fieldset>
				))}
				{coupled && labels.coupledHint && (
					<p className={`mt-3 text-xs leading-5 ${muted}`}>{labels.coupledHint}</p>
				)}
				{(selectedCell?.controls ?? []).map((control) => (
					<fieldset key={control.key} className="mt-4">
						<legend className={`text-xs font-semibold ${muted}`}>{labels[control.key]}</legend>
						<div
							className={`mt-2 gap-1 p-1 grid auto-cols-fr grid-flow-col rounded-xl ${dark ? "bg-black/10" : "bg-muted/40"}`}
						>
							{control.options.map((option) => (
								<button
									key={option.key}
									type="button"
									aria-pressed={controlValues[control.key] === option.key}
									disabled={disabled || !onControlChange}
									className={optionStyle(controlValues[control.key] === option.key)}
									onClick={() => onControlChange?.(control.key, option.key)}
								>
									{labels.optionLabels?.[option.key] ?? option.label}
								</button>
							))}
						</div>
					</fieldset>
				))}
				<div
					className={`mt-4 gap-2 pt-3 text-xs flex flex-wrap items-center justify-between border-t ${dark ? "border-white/10" : "border-foreground/10"}`}
				>
					<span className={`gap-1.5 flex items-center ${muted}`} title={labels.oneOutput}>
						<ImageIcon className="size-3.5" aria-hidden="true" />
						{labels.outputNumber}: 1
					</span>
					<output
						aria-live="polite"
						className="font-semibold"
						data-test={`${idPrefix}-settings-credits`}
					>
						{selectedCell
							? `${selectedCell.label} · ${selectedCell.credits} ${labels.credits ?? "Credits"}`
							: modeLabel}
					</output>
				</div>
			</PopoverContent>
		</Popover>
	);
}
