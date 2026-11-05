"use client";

import { Dialog, DialogContent, DialogTitle } from "@repo/ui/components/dialog";
import { ChevronsLeftRightIcon, ZoomInIcon } from "lucide-react";
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
	enlargeOriginalLabel,
	enlargeResultLabel,
	closeLabel,
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
	enlargeOriginalLabel: string;
	enlargeResultLabel: string;
	closeLabel: string;
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
	const [enlarged, setEnlarged] = useState<"before" | "after" | null>(null);
	const canCompare = Boolean(beforeUrl && beforeUrl !== failedBeforeUrl);
	const sideBySide = canCompare && view === "side-by-side";
	const sliding = canCompare && view === "slider";
	const enlargedUrl =
		enlarged === "before" && canCompare ? beforeUrl : enlarged === "after" ? afterUrl : undefined;

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
				<button
					type="button"
					aria-label={enlargeResultLabel}
					aria-haspopup="dialog"
					tabIndex={sliding ? -1 : 0}
					onClick={() => setEnlarged("after")}
					className={
						sideBySide
							? "min-w-0 sm:h-[min(70vh,32rem)] relative order-2 cursor-zoom-in overflow-hidden rounded-2xl border bg-muted focus-visible:ring-2 focus-visible:ring-ring"
							: sliding
								? "inset-0 absolute"
								: "block w-full cursor-zoom-in rounded-xl focus-visible:ring-2 focus-visible:ring-ring"
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
					{sideBySide && (
						<span className="top-3 right-3 px-2 py-1 text-xs gap-1 absolute inline-flex items-center rounded-full bg-background/90">
							{afterLabel}
							<ZoomInIcon className="size-3" aria-hidden="true" />
						</span>
					)}
				</button>
				{canCompare && (
					<>
						<button
							type="button"
							aria-label={enlargeOriginalLabel}
							aria-haspopup="dialog"
							tabIndex={sliding ? -1 : 0}
							onClick={() => setEnlarged("before")}
							className={
								sideBySide
									? "min-w-0 sm:h-[min(70vh,32rem)] relative order-1 cursor-zoom-in overflow-hidden rounded-2xl border bg-muted focus-visible:ring-2 focus-visible:ring-ring"
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
							{sideBySide && (
								<span className="top-3 left-3 px-2 py-1 text-xs gap-1 absolute inline-flex items-center rounded-full bg-background/90">
									{beforeLabel}
									<ZoomInIcon className="size-3" aria-hidden="true" />
								</span>
							)}
						</button>
						{sliding && (
							<>
								<button
									type="button"
									aria-label={enlargeOriginalLabel}
									aria-haspopup="dialog"
									onClick={() => setEnlarged("before")}
									className="left-3 top-3 gap-1 px-2 py-1 text-xs absolute z-10 inline-flex items-center rounded-full bg-background/90 focus-visible:ring-2 focus-visible:ring-ring"
								>
									{beforeLabel}
									<ZoomInIcon className="size-3" aria-hidden="true" />
								</button>
								<button
									type="button"
									aria-label={enlargeResultLabel}
									aria-haspopup="dialog"
									onClick={() => setEnlarged("after")}
									className="right-3 top-3 gap-1 px-2 py-1 text-xs absolute z-10 inline-flex items-center rounded-full bg-background/90 focus-visible:ring-2 focus-visible:ring-ring"
								>
									{afterLabel}
									<ZoomInIcon className="size-3" aria-hidden="true" />
								</button>
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
			<Dialog
				open={Boolean(enlargedUrl)}
				onOpenChange={(open) => {
					if (!open) setEnlarged(null);
				}}
			>
				{enlargedUrl && (
					<DialogContent
						className="border-white/15 bg-black/95 p-4 text-white md:w-[calc(100vw-2rem)] h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none grid-rows-[auto_minmax(0,1fr)]"
						overlayProps={{ className: "bg-black/80" }}
						closeLabel={closeLabel}
						aria-describedby={undefined}
					>
						<DialogTitle>{enlarged === "before" ? beforeLabel : afterLabel}</DialogTitle>
						<button
							type="button"
							className="min-h-0 w-full cursor-zoom-out"
							aria-label={closeLabel}
							onClick={() => setEnlarged(null)}
						>
							<img
								data-clarity-mask="true"
								src={enlargedUrl}
								alt={enlarged === "before" ? beforeAlt : (outputOnlyAlt ?? afterAlt)}
								className="size-full object-contain"
								referrerPolicy="no-referrer"
								onError={() => setEnlarged(null)}
							/>
						</button>
					</DialogContent>
				)}
			</Dialog>
		</div>
	);
}
