"use client";

import { ChevronsLeftRightIcon } from "lucide-react";
import { useState, type ReactEventHandler } from "react";

export function BeforeAfterSlider({
	beforeUrl,
	afterUrl,
	beforeAlt,
	afterAlt,
	outputOnlyAlt,
	controlLabel,
	sideBySideLabel,
	sliderLabel,
	showOriginalLabel,
	showResultLabel,
	beforeLabel,
	afterLabel,
	onCompared,
	onOutputLoad,
	onOutputError,
}: {
	beforeUrl?: string;
	afterUrl: string;
	beforeAlt: string;
	afterAlt: string;
	outputOnlyAlt?: string;
	controlLabel: string;
	sideBySideLabel: string;
	sliderLabel: string;
	showOriginalLabel: string;
	showResultLabel: string;
	beforeLabel: string;
	afterLabel: string;
	onCompared?: () => void;
	onOutputLoad?: ReactEventHandler<HTMLImageElement>;
	onOutputError?: ReactEventHandler<HTMLImageElement>;
}) {
	const [position, setPosition] = useState(50);
	const [view, setView] = useState<"side-by-side" | "slider">("side-by-side");
	const [failedBeforeUrl, setFailedBeforeUrl] = useState<string>();
	const canCompare = Boolean(beforeUrl && beforeUrl !== failedBeforeUrl);
	const sideBySide = canCompare && view === "side-by-side";
	const sliding = canCompare && view === "slider";

	return (
		<div className={canCompare ? "space-y-3" : undefined}>
			<div
				data-comparison-view={canCompare ? view : undefined}
				className={
					sideBySide
						? "gap-3 sm:grid-cols-2 grid grid-cols-1"
						: sliding
							? "sm:aspect-[4/3] relative aspect-square overflow-hidden rounded-2xl border bg-muted focus-within:ring-2 focus-within:ring-ring"
							: undefined
				}
			>
				{/* Keep the output and its parent mounted through loading and view changes. */}
				<div
					className={
						sideBySide
							? "min-w-0 sm:h-[min(70vh,32rem)] relative order-2 overflow-hidden rounded-2xl border bg-muted"
							: sliding
								? "inset-0 absolute"
								: undefined
					}
				>
					<img
						data-clarity-mask="true"
						src={afterUrl}
						alt={canCompare ? afterAlt : (outputOnlyAlt ?? afterAlt)}
						onLoad={onOutputLoad}
						onError={onOutputError}
						className={
							sideBySide
								? "px-2 pb-2 pt-10 sm:size-full sm:max-h-none h-auto max-h-[32rem] w-full object-contain"
								: sliding
									? "size-full object-contain"
									: "mx-auto max-h-[42rem] w-full rounded-xl object-contain"
						}
					/>
					{canCompare && (
						<span className="top-3 right-3 px-2 py-1 text-xs absolute rounded-full bg-background/90">
							{afterLabel}
						</span>
					)}
				</div>
				{canCompare && (
					<>
						<div
							className={
								sideBySide
									? "min-w-0 sm:h-[min(70vh,32rem)] relative order-1 overflow-hidden rounded-2xl border bg-muted"
									: "inset-0 absolute overflow-hidden bg-muted"
							}
							style={sliding ? { clipPath: `inset(0 ${100 - position}% 0 0)` } : undefined}
						>
							<img
								data-clarity-mask="true"
								src={beforeUrl}
								alt={beforeAlt}
								onError={() => setFailedBeforeUrl(beforeUrl)}
								className={
									sideBySide
										? "px-2 pb-2 pt-10 sm:size-full sm:max-h-none h-auto max-h-[32rem] w-full object-contain"
										: "size-full object-contain"
								}
							/>
							<span className="top-3 left-3 px-2 py-1 text-xs absolute rounded-full bg-background/90">
								{beforeLabel}
							</span>
						</div>
						{sliding && (
							<>
								<div
									className="inset-y-0 w-0.5 bg-white shadow pointer-events-none absolute"
									style={{ left: `${position}%` }}
									aria-hidden="true"
								>
									<span className="size-8 shadow absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-foreground">
										<ChevronsLeftRightIcon className="size-4" />
									</span>
								</div>
								<input
									type="range"
									min={0}
									max={100}
									value={position}
									aria-label={controlLabel}
									onChange={(event) => {
										setPosition(Number(event.target.value));
										onCompared?.();
									}}
									className="inset-0 absolute h-full w-full cursor-ew-resize opacity-0"
								/>
							</>
						)}
					</>
				)}
			</div>
			{canCompare && (
				<fieldset className="gap-2 flex flex-wrap" aria-label={controlLabel}>
					<button
						type="button"
						aria-pressed={sideBySide}
						onClick={() => {
							setView("side-by-side");
							onCompared?.();
						}}
						className="px-3 py-2 text-sm rounded-lg border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:bg-muted"
					>
						{sideBySideLabel}
					</button>
					<button
						type="button"
						aria-pressed={sliding}
						onClick={() => {
							setView("slider");
							setPosition(50);
							onCompared?.();
						}}
						className="px-3 py-2 text-sm rounded-lg border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:bg-muted"
					>
						{sliderLabel}
					</button>
					{sliding && (
						<>
							<button
								type="button"
								aria-pressed={position === 100}
								onClick={() => {
									setPosition(100);
									onCompared?.();
								}}
								className="px-3 py-2 text-sm rounded-lg border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							>
								{showOriginalLabel}
							</button>
							<button
								type="button"
								aria-pressed={position === 0}
								onClick={() => {
									setPosition(0);
									onCompared?.();
								}}
								className="px-3 py-2 text-sm rounded-lg border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							>
								{showResultLabel}
							</button>
						</>
					)}
				</fieldset>
			)}
		</div>
	);
}
