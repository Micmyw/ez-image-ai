"use client";

import { useState } from "react";

export function BeforeAfterSlider({
	beforeUrl,
	afterUrl,
	beforeAlt,
	afterAlt,
	controlLabel,
	showOriginalLabel,
	showResultLabel,
	beforeLabel,
	afterLabel,
}: {
	beforeUrl: string;
	afterUrl: string;
	beforeAlt: string;
	afterAlt: string;
	controlLabel: string;
	showOriginalLabel: string;
	showResultLabel: string;
	beforeLabel: string;
	afterLabel: string;
}) {
	const [position, setPosition] = useState(50);

	return (
		<div className="space-y-3">
			<div className="sm:aspect-[4/3] relative aspect-square overflow-hidden rounded-2xl border bg-muted">
				<img src={afterUrl} alt={afterAlt} className="inset-0 absolute size-full object-contain" />
				<span className="top-3 right-3 px-2 py-1 text-xs absolute rounded-full bg-background/90">
					{afterLabel}
				</span>
				<div
					className="inset-0 absolute overflow-hidden"
					style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
				>
					<img src={beforeUrl} alt={beforeAlt} className="size-full object-contain" />
					<span className="top-3 left-3 px-2 py-1 text-xs absolute rounded-full bg-background/90">
						{beforeLabel}
					</span>
				</div>
				<div
					className="inset-y-0 w-0.5 bg-white shadow pointer-events-none absolute"
					style={{ left: `${position}%` }}
					aria-hidden="true"
				/>
				<input
					type="range"
					min={0}
					max={100}
					value={position}
					aria-label={controlLabel}
					onChange={(event) => setPosition(Number(event.target.value))}
					className="inset-0 absolute h-full w-full cursor-ew-resize opacity-0"
				/>
			</div>
			<div className="gap-2 flex flex-wrap">
				<button
					type="button"
					onClick={() => setPosition(100)}
					className="px-3 py-2 text-sm rounded-lg border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					{showOriginalLabel}
				</button>
				<button
					type="button"
					onClick={() => setPosition(0)}
					className="px-3 py-2 text-sm rounded-lg border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					{showResultLabel}
				</button>
			</div>
		</div>
	);
}
