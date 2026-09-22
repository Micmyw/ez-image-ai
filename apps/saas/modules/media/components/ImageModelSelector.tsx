"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/components/popover";
import { CheckIcon, ChevronDownIcon, CoinsIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { PublicImageSpecMatrix } from "../lib/image-sku-selection";
import { ImageModelIcon } from "./ImageModelIcon";

const modelGroups = [
	{
		key: "nano",
		label: "Nano Banana",
		prefix: "image-nano-banana",
	},
	{
		key: "gpt",
		label: "GPT Image",
		prefix: "image-gpt-image",
	},
	{
		key: "seedream",
		label: "Seedream",
		prefix: "image-seedream",
	},
] as const;

interface ImageModelOption {
	key: string;
	label: string;
	description: string;
	skuMatrix: PublicImageSpecMatrix;
	requiresUpgrade?: boolean;
}

export function ImageModelSelector({
	idPrefix,
	products,
	value,
	valueLabel,
	onChange,
	disabled = false,
}: {
	idPrefix: string;
	products: readonly ImageModelOption[];
	value: string | null;
	valueLabel?: string;
	onChange: (key: string) => void;
	disabled?: boolean;
}) {
	const t = useTranslations("media.create.modelMenu");
	const [open, setOpen] = useState(false);
	const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
	const groups = modelGroups.filter((group) =>
		products.some((product) => product.key.startsWith(group.prefix)),
	);
	const selected = products.find((product) => product.key === value);
	const selectedLabel = selected?.label ?? valueLabel;
	const selectedGroup = groups.find((group) => selected?.key.startsWith(group.prefix)) ?? groups[0];
	const activeGroup = groups.find((group) => group.key === activeGroupKey) ?? selectedGroup;

	return (
		<Popover
			open={open}
			onOpenChange={(nextOpen) => {
				setOpen(nextOpen);
				if (nextOpen) setActiveGroupKey(selectedGroup?.key ?? null);
			}}
		>
			<PopoverTrigger
				render={
					<button
						type="button"
						data-test={`${idPrefix}-model-trigger`}
						aria-label={t("trigger", { model: selectedLabel ?? t("choose") })}
						disabled={disabled || !groups.length}
						className="min-h-11 min-w-0 gap-2 px-3 text-xs font-semibold border-white/10 bg-white/[0.055] hover:bg-white/10 focus-visible:outline-violet-300 inline-flex max-w-full items-center rounded-lg border text-[#f2ecfa] transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
					>
						<ImageModelIcon productKey={selected?.key ?? value ?? undefined} size={18} />
						<span className="truncate">{selectedLabel ?? t("choose")}</span>
						<ChevronDownIcon className="size-3.5 shrink-0 text-[#a99db2]" aria-hidden="true" />
					</button>
				}
			/>
			<PopoverContent
				align="start"
				side="top"
				sticky
				sideOffset={8}
				positionerClassName="z-[80]"
				aria-label={t("title")}
				className="border-white/10 p-2 max-h-[var(--available-height)] w-[min(38rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-2xl bg-[#261d31] text-[#f2ecfa] shadow-[0_24px_64px_-16px_rgba(0,0,0,0.65)]"
			>
				<h3 className="px-2 py-2 font-semibold tracking-widest text-[0.65rem] text-[#a99db2] uppercase">
					{t("title")}
				</h3>
				<div className="gap-2 sm:grid-cols-[10.5rem_minmax(0,1fr)] grid grid-cols-[minmax(0,1fr)]">
					<fieldset
						className="min-w-0 gap-1 bg-black/10 p-1 sm:flex-col flex rounded-xl"
						aria-label={t("groups")}
					>
						{groups.map((group) => (
							<button
								key={group.key}
								type="button"
								aria-label={group.label}
								aria-pressed={group.key === activeGroup?.key}
								onClick={() => setActiveGroupKey(group.key)}
								className={`min-h-11 min-w-0 gap-2 p-2 focus-visible:outline-violet-300 sm:flex-initial flex-1 rounded-lg text-left transition focus-visible:outline-2 ${group.key === activeGroup?.key ? "bg-[#4b3a64]" : "hover:bg-white/5"}`}
							>
								<span className="gap-1.5 sm:gap-2 sm:flex-row flex flex-col items-center">
									<ImageModelIcon productKey={group.prefix} size={20} />
									<span className="min-w-0 sm:text-left text-center">
										<span className="min-h-8 sm:min-h-0 text-xs font-semibold flex items-center">
											{group.label}
										</span>
										<span className="mt-1 sm:block hidden text-[0.65rem] text-[#b2a7bc]">
											{t(`groupDescriptions.${group.key}`)}
										</span>
									</span>
								</span>
							</button>
						))}
					</fieldset>
					<fieldset
						className="min-w-0 space-y-1 bg-white/[0.025] p-1 rounded-xl"

						aria-label={activeGroup?.label}
					>
						{products
							.filter((product) => activeGroup && product.key.startsWith(activeGroup.prefix))
							.map((product) => {
								const chosen = product.key === value;
								const credits = Math.min(...product.skuMatrix.cells.map((cell) => cell.credits));
								const variedPrice = product.skuMatrix.cells.some(
									(cell) => cell.credits !== credits,
								);
								const maxResolution = product.skuMatrix.dimensions
									.find((dimension) => dimension.key === "resolution")
									?.options.filter((option) =>
										product.skuMatrix.cells.some(
											(cell) => cell.parameterValues.resolution === option.key,
										),
									)
									.at(-1)?.label;
								return (
									<button
										key={product.key}
										type="button"
										data-test={`${idPrefix}-model-${product.key}`}
										aria-pressed={chosen}
										onClick={() => {
											onChange(product.key);
											setOpen(false);
										}}
										className={`gap-3 p-3 focus-visible:outline-violet-300 flex w-full items-start rounded-xl text-left transition focus-visible:outline-2 ${chosen ? "bg-[#4b3a64]" : "hover:bg-white/5"}`}
									>
										<span className="size-8 bg-black/20 grid shrink-0 place-items-center rounded-lg">
											<ImageModelIcon productKey={product.key} size={20} />
										</span>
										<span className="min-w-0 flex-1">
											<span className="gap-2 text-sm font-semibold flex flex-wrap items-center">
												{product.label}
												{maxResolution && (
													<span className="rounded bg-white/10 px-1.5 py-0.5 font-medium text-[0.6rem] text-[#c9b9df]">
														{t("upToResolution", { resolution: maxResolution })}
													</span>
												)}
												{product.requiresUpgrade && (
													<span className="rounded bg-amber-300/10 px-1.5 py-0.5 font-medium text-amber-200 text-[0.6rem]">
														{t("paidPlan")}
													</span>
												)}
											</span>
											<span className="mt-1 text-xs leading-5 block text-[#bfb3cd]">
												{product.description}
											</span>
											<span className="mt-1.5 gap-1.5 flex items-center text-[0.7rem] text-[#d0c3e0]">
												<CoinsIcon className="size-3" aria-hidden="true" />
												{t(variedPrice ? "fromCredits" : "credits", { credits })}
											</span>
										</span>
										{chosen && (
											<CheckIcon
												className="mt-1 size-4 text-violet-200 shrink-0"
												aria-hidden="true"
											/>
										)}
									</button>
								);
							})}
					</fieldset>
				</div>
			</PopoverContent>
		</Popover>
	);
}
