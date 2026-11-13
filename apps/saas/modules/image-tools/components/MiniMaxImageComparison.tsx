"use client";

import { useId, useState } from "react";

import type { ImageToolExampleImage } from "../lib/tool-pages";

export function MiniMaxImageComparison({
	before,
	after,
	resolution,
}: {
	before: ImageToolExampleImage;
	after: ImageToolExampleImage;
	resolution: string;
}) {
	const [position, setPosition] = useState(48);
	const id = useId();
	return (
		<div className="minimax-comparison">
			<img
				src={before.src}
				alt={before.alt}
				width={before.width}
				height={before.height}
				loading="lazy"
				decoding="async"
			/>
			<div className="minimax-comparison-after" style={{ clipPath: `inset(0 0 0 ${position}%)` }}>
				<img
					src={after.src}
					alt={after.alt}
					width={after.width}
					height={after.height}
					loading="lazy"
					decoding="async"
				/>
			</div>
			<div className="minimax-comparison-labels" aria-hidden="true">
				<span>Original</span>
				<span>After · {resolution}</span>
			</div>
			<div
				className="minimax-comparison-divider"
				style={{ left: `${position}%` }}
				aria-hidden="true"
			>
				<span>‹ ›</span>
			</div>
			<label className="sr-only" htmlFor={id}>
				Compare the original and edited photo
			</label>
			<input
				id={id}
				type="range"
				min={0}
				max={100}
				value={position}
				aria-valuetext={`${position}% original photo`}
				onChange={(event) => setPosition(Number(event.target.value))}
			/>
		</div>
	);
}
