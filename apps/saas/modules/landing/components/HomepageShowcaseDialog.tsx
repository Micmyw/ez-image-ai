"use client";

import { trackBrowserGrowthEvent } from "@repo/utils/lib/growth-analytics-browser";
import {
	ArrowLeftRightIcon,
	ArrowRightIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ImageIcon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
	Volume2Icon,
	VolumeXIcon,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import { type HomepageShowcaseCopy, type HomepageShowcaseSlide } from "../lib/homepage-showcase";

export function HomepageShowcaseDialogContent({
	slides,
	copy,
	index,
	setIndex,
	open,
	showPicker,
	titleRef,
}: {
	slides: HomepageShowcaseSlide[];
	copy: HomepageShowcaseCopy;
	index: number;
	setIndex: (value: number) => void;
	open: boolean;
	showPicker: boolean;
	titleRef: RefObject<HTMLHeadingElement | null>;
}) {
	const slide = slides[index];

	if (!slide) return null;
	const select = (nextIndex: number) => {
		const selected = slides[nextIndex];
		if (!selected) return;
		void trackBrowserGrowthEvent({
			name: "homepage_idea_preview_selected",
			properties: { homepageIdea: selected.key, homepagePlacement: "showcase", status: "selected" },
		});
		setIndex(nextIndex);
	};
	return (
		<>
			<div className="homepage-showcase-media" data-kind={slide.kind}>
				<div className="homepage-showcase-scene" key={slide.key}>
					{slide.kind === "video" ? (
						open && <ShowcaseVideo slide={slide} copy={copy} />
					) : (
						<ShowcaseImage slide={slide} copy={copy} />
					)}
				</div>
				<span className="homepage-showcase-sample">
					{slide.kind === "video" ? (
						<PlayIcon size={12} aria-hidden="true" />
					) : (
						<ImageIcon size={12} aria-hidden="true" />
					)}
					{slide.kind === "video" ? copy.video : copy.image}
				</span>
			</div>
			<div className="homepage-showcase-body">
				<div className="homepage-showcase-heading">
					<div aria-live="polite" aria-atomic="true">
						<p className="homepage-showcase-eyebrow">{copy.eyebrow}</p>
						<h2
							ref={titleRef}
							id="homepage-showcase-title"
							tabIndex={-1}
							className="homepage-showcase-title"
							data-showcase-title=""
						>
							{slide.title}
						</h2>
						<p id="homepage-showcase-description" className="homepage-showcase-description">
							{slide.description}
						</p>
					</div>
					<a
						href={slide.href}
						className="homepage-showcase-cta"
						data-showcase-create=""
						data-showcase-prompt={slide.prompt}
						data-test="showcase-create"
					>
						{slide.action}
						<ArrowRightIcon size={17} aria-hidden="true" />
					</a>
				</div>
				{showPicker && (
					<div className="homepage-showcase-navigation">
						<button
							type="button"
							className="homepage-showcase-arrow"
							aria-label={copy.previous}
							onClick={() => select((index - 1 + slides.length) % slides.length)}
						>
							<ChevronLeftIcon aria-hidden="true" />
						</button>
						<div className="homepage-showcase-picker" aria-label={copy.eyebrow}>
							{slides.map((item, itemIndex) => (
								<button
									key={item.key}
									type="button"
									aria-label={item.label}
									aria-pressed={index === itemIndex}
									onClick={() => select(itemIndex)}
								>
									<img src={item.thumbnail} alt="" width={144} height={102} loading="lazy" />
									<span>{item.label}</span>
									{item.kind === "video" && <PlayIcon size={11} aria-hidden="true" />}
								</button>
							))}
						</div>
						<button
							type="button"
							className="homepage-showcase-arrow"
							aria-label={copy.next}
							onClick={() => select((index + 1) % slides.length)}
						>
							<ChevronRightIcon aria-hidden="true" />
						</button>
					</div>
				)}
			</div>
		</>
	);
}

function ShowcaseImage({
	slide,
	copy,
}: {
	slide: Exclude<HomepageShowcaseSlide, { kind: "video" }>;
	copy: HomepageShowcaseCopy;
}) {
	const [ready, setReady] = useState(0);
	const imageReady = () => setReady((value) => value + 1);
	if (slide.kind === "gallery")
		return (
			<div className="homepage-showcase-triptych" data-ready={ready >= slide.images.length}>
				{slide.images.map((src, index) => (
					<img
						key={src}
						src={src}
						alt={`${slide.title} ${index + 1}`}
						draggable={false}
						onLoad={imageReady}
						onError={imageReady}
					/>
				))}
			</div>
		);
	if (slide.kind === "portrait")
		return (
			<div className="homepage-showcase-portrait" data-ready={ready >= 2}>
				<figure className="homepage-showcase-source">
					<img
						src={slide.before}
						alt={copy.before}
						draggable={false}
						onLoad={imageReady}
						onError={imageReady}
					/>
					<figcaption>{copy.before}</figcaption>
				</figure>
				<ArrowRightIcon className="homepage-showcase-portrait-arrow" aria-hidden="true" />
				<figure className="homepage-showcase-result">
					<img
						src={slide.poster}
						alt={slide.title}
						draggable={false}
						onLoad={imageReady}
						onError={imageReady}
					/>
					<figcaption>{copy.after}</figcaption>
				</figure>
			</div>
		);
	return (
		<div className="homepage-showcase-comparison" data-reveal="intro" suppressHydrationWarning>
			<img
				data-showcase-source="before"
				alt={copy.before}
				fetchPriority="high"
				draggable={false}
				suppressHydrationWarning
			/>
			<div className="homepage-showcase-edited">
				<img
					data-showcase-source="poster"
					alt={slide.title}
					fetchPriority="high"
					draggable={false}
					suppressHydrationWarning
				/>
			</div>
			<div className="homepage-showcase-divider" aria-hidden="true">
				<span>
					<ArrowLeftRightIcon size={19} />
				</span>
			</div>
			<span className="homepage-showcase-before">{copy.before}</span>
			<span className="homepage-showcase-after">{copy.after}</span>
			<input
				type="range"
				min={0}
				max={100}
				defaultValue={50}
				aria-label={copy.compare}
				aria-valuetext={`${copy.after} 50%`}
				data-showcase-after={copy.after}
				suppressHydrationWarning
			/>
			<span className="homepage-showcase-drag">
				<ArrowLeftRightIcon size={13} aria-hidden="true" />
				{copy.compare}
			</span>
		</div>
	);
}

function ShowcaseVideo({
	slide,
	copy,
}: {
	slide: Extract<HomepageShowcaseSlide, { kind: "video" }>;
	copy: HomepageShowcaseCopy;
}) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const userPaused = useRef(false);
	const [playing, setPlaying] = useState(false);
	const [muted, setMuted] = useState(true);
	const [failed, setFailed] = useState(false);
	const [time, setTime] = useState(0);
	const [duration, setDuration] = useState(0);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		// Strict Mode may run setup again after cleanup released this source.
		if (video.getAttribute("src") !== slide.video) video.setAttribute("src", slide.video);
		let active = true;
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const syncPlayback = () => {
			if (document.visibilityState !== "visible" || motion.matches || userPaused.current)
				video.pause();
			else
				void video.play().catch(() => {
					if (active) setPlaying(false);
				});
		};
		syncPlayback();
		document.addEventListener("visibilitychange", syncPlayback);
		motion.addEventListener("change", syncPlayback);
		return () => {
			active = false;
			document.removeEventListener("visibilitychange", syncPlayback);
			motion.removeEventListener("change", syncPlayback);
			video.pause();
			video.removeAttribute("src");
			video.load();
		};
	}, [slide.video]);

	function togglePlayback() {
		const video = videoRef.current;
		if (!video) return;
		if (playing) {
			userPaused.current = true;
			video.pause();
		} else {
			userPaused.current = false;
			if (failed) {
				setFailed(false);
				video.load();
			}
			void video.play().catch(() => setPlaying(false));
		}
	}
	const seconds = (value: number) =>
		`${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
	return (
		<div className="homepage-showcase-player">
			{/* Motion examples have equivalent text descriptions immediately below the player. */}
			{/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
			<video
				ref={videoRef}
				src={slide.video}
				poster={slide.poster}
				muted={muted}
				loop
				playsInline
				preload="metadata"
				aria-label={slide.title}
				onPlay={() => setPlaying(true)}
				onPause={() => setPlaying(false)}
				onError={() => {
					setFailed(true);
					setPlaying(false);
				}}
				onLoadedMetadata={(event) =>
					setDuration(
						Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0,
					)
				}
				onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
			/>
			{!playing && (
				<button
					type="button"
					className="homepage-showcase-play"
					onClick={togglePlayback}
					aria-label={failed ? copy.retry : copy.play}
				>
					{failed ? <RotateCcwIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
				</button>
			)}
			<div className="homepage-showcase-controls">
				<button
					type="button"
					aria-label={playing ? copy.pause : copy.play}
					onClick={togglePlayback}
				>
					{playing ? (
						<PauseIcon size={17} aria-hidden="true" />
					) : (
						<PlayIcon size={17} aria-hidden="true" />
					)}
				</button>
				<span className="homepage-showcase-time" aria-hidden="true">
					{seconds(time)} / {seconds(duration)}
				</span>
				<progress aria-label={copy.progress} max={duration || 1} value={time} />
				<button
					type="button"
					aria-label={muted ? copy.unmute : copy.mute}
					onClick={() => setMuted((current) => !current)}
				>
					{muted ? (
						<VolumeXIcon size={18} aria-hidden="true" />
					) : (
						<Volume2Icon size={18} aria-hidden="true" />
					)}
				</button>
			</div>
		</div>
	);
}
