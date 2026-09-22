"use client";

import { ArrowLeftRightIcon, ArrowUpRightIcon, CheckIcon, ImageIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import artwork from "../lib/image-to-image-artwork.json";
import {
	LANDING_PROMPT_SELECTED_EVENT,
	type LandingPromptSelectedDetail,
} from "../lib/prompt-selection";

export type ImageExampleKey = "background" | "portrait" | "style";
export interface ImageExample {
	key: ImageExampleKey;
	label: string;
	title: string;
	body: string;
	prompt: string;
	beforeAlt: string;
	afterAlt: string;
}
export interface ImageExampleLabels {
	title: string;
	intro: string;
	choose: string;
	before: string;
	after: string;
	compare: string;
	drag: string;
	prompt: string;
	usePrompt: string;
	promptAdded: string;
	ownImage: string;
	note: string;
}

function ExampleImage({
	itemKey,
	version,
	alt,
	thumbnail = false,
}: {
	itemKey: ImageExampleKey;
	version: "before" | "after";
	alt: string;
	thumbnail?: boolean;
}) {
	const asset = artwork[`${itemKey}-${version}`];
	return (
		<img
			src={asset.variants[1].src}
			srcSet={asset.variants.map((variant) => `${variant.src} ${variant.width}w`).join(", ")}
			sizes={thumbnail ? "72px" : "(min-width: 1024px) 540px, (min-width: 768px) 50vw, 100vw"}
			width={asset.width}
			height={asset.height}
			alt={alt}
			loading="lazy"
			decoding="async"
			draggable={false}
		/>
	);
}

function ImageComparison({ item, labels }: { item: ImageExample; labels: ImageExampleLabels }) {
	const [position, setPosition] = useState(50);
	const source = artwork[`${item.key}-before`];
	const modes = [
		{ value: 100, label: labels.before },
		{ value: 50, label: labels.compare },
		{ value: 0, label: labels.after },
	];
	return (
		<div className="image-edit-comparison" data-image-comparison="">
			<div className="image-edit-comparison-toolbar">
				<span className="image-edit-drag-hint">
					<ArrowLeftRightIcon size={14} aria-hidden="true" />
					{labels.drag}
				</span>
				<fieldset className="image-edit-view-options" aria-label={labels.compare}>
					{modes.map((mode) => (
						<button
							key={mode.value}
							type="button"
							aria-pressed={position === mode.value}
							onClick={() => setPosition(mode.value)}
						>
							{mode.label}
						</button>
					))}
				</fieldset>
			</div>
			<div className="image-edit-comparison-stage">
				<div
					className="image-edit-comparison-art"
					style={{
						aspectRatio: `${source.width} / ${source.height}`,
						width: `min(100%, calc(var(--image-edit-stage-height) * ${source.width / source.height}))`,
					}}
				>
					<ExampleImage itemKey={item.key} version="after" alt={item.afterAlt} />
					<div
						className="image-edit-original-layer"
						style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
					>
						<ExampleImage itemKey={item.key} version="before" alt={item.beforeAlt} />
					</div>
					<div
						className="image-edit-divider"
						style={{ left: `${position}%` }}
						aria-hidden="true"
						hidden={position === 0 || position === 100}
					>
						<span>
							<ArrowLeftRightIcon size={18} />
						</span>
					</div>
					<input
						type="range"
						min={0}
						max={100}
						value={position}
						aria-label={`${labels.compare}: ${item.label}`}
						aria-valuetext={`${labels.before} ${position}%, ${labels.after} ${100 - position}%`}
						onChange={(event) => setPosition(Number(event.target.value))}
					/>
					<span className="image-edit-image-label image-edit-before-label" hidden={position === 0}>
						{labels.before}
					</span>
					<span className="image-edit-image-label image-edit-after-label" hidden={position === 100}>
						{labels.after}
					</span>
				</div>
			</div>
		</div>
	);
}

export function ImageToImageExamples({
	items,
	labels,
}: {
	items: ImageExample[];
	labels: ImageExampleLabels;
}) {
	const [selected, setSelected] = useState<ImageExampleKey>("background");
	const [applied, setApplied] = useState<ImageExampleKey | null>(null);
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

	function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
		let next: number;
		if (event.key === "ArrowRight") next = (index + 1) % items.length;
		else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = items.length - 1;
		else return;
		event.preventDefault();
		setSelected(items[next]!.key);
		tabRefs.current[next]?.focus();
	}

	function applyPrompt(item: ImageExample) {
		window.dispatchEvent(
			new CustomEvent<LandingPromptSelectedDetail>(LANDING_PROMPT_SELECTED_EVENT, {
				detail: { prompt: item.prompt },
			}),
		);
		setApplied(item.key);
		const editor = document.getElementById("image-editor");
		editor?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
		editor?.scrollIntoView({
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			block: "start",
		});
	}

	return (
		<section
			className="image-edit-examples container"
			id="image-to-image-examples"
			aria-labelledby="image-to-image-prompts"
		>
			<div className="image-edit-section-heading">
				<div>
					<p className="image-edit-eyebrow">
						<ImageIcon size={15} aria-hidden="true" />
						{labels.choose}
					</p>
					<h2 id="image-to-image-prompts">{labels.title}</h2>
				</div>
				<p>{labels.intro}</p>
			</div>
			<div className="image-edit-tabs" role="tablist" aria-label={labels.choose}>
				{items.map((item, index) => (
					<button
						key={item.key}
						ref={(element) => {
							tabRefs.current[index] = element;
						}}
						type="button"
						role="tab"
						id={`image-example-tab-${item.key}`}
						aria-controls={`image-example-${item.key}`}
						aria-selected={selected === item.key}
						tabIndex={selected === item.key ? 0 : -1}
						onClick={() => setSelected(item.key)}
						onKeyDown={(event) => navigateTabs(event, index)}
					>
						<span className="image-edit-tab-art">
							<ExampleImage itemKey={item.key} version="after" alt="" thumbnail />
						</span>
						<span>{item.label}</span>
						<ArrowUpRightIcon className="image-edit-tab-arrow" size={17} aria-hidden="true" />
					</button>
				))}
			</div>
			{items.map((item) => (
				<div
					key={item.key}
					id={`image-example-${item.key}`}
					role="tabpanel"
					aria-labelledby={`image-example-tab-${item.key}`}
					hidden={selected !== item.key}
					tabIndex={0}
					className="image-edit-panel"
				>
					<ImageComparison item={item} labels={labels} />
					<article className="image-edit-example-copy">
						<span className="image-edit-example-category">{item.label}</span>
						<h3>{item.title}</h3>
						<p className="image-edit-example-description">{item.body}</p>
						<div className="image-edit-prompt-card">
							<p>{labels.prompt}</p>
							<blockquote>{item.prompt}</blockquote>
						</div>
						<button
							type="button"
							className="image-edit-use-prompt"
							onClick={() => applyPrompt(item)}
						>
							{labels.usePrompt}
							<ArrowUpRightIcon size={18} aria-hidden="true" />
						</button>
						<p className="image-edit-own-image">{labels.ownImage}</p>
					</article>
				</div>
			))}
			<div className="image-edit-example-footnote">
				<p>{labels.note}</p>
				<output aria-live="polite">
					{applied && (
						<>
							<CheckIcon size={14} aria-hidden="true" />
							{labels.promptAdded}
						</>
					)}
				</output>
			</div>
		</section>
	);
}
