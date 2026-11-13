"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@repo/ui/components/dialog";
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
	SparklesIcon,
	Volume2Icon,
	VolumeXIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
	canAutoShowHomepageShowcase,
	HOMEPAGE_SHOWCASE_SEEN_KEY,
	type HomepageShowcaseCopy,
	type HomepageShowcaseSlide,
} from "../lib/homepage-showcase";
import { useLandingPromptSelection } from "../lib/use-landing-prompt-selection";

import "./homepage-showcase.css";

export function HomepageShowcase({
	slides,
	copy,
}: {
	slides: HomepageShowcaseSlide[];
	copy: HomepageShowcaseCopy;
}) {
	const [open, setOpen] = useState(false);
	const [index, setIndex] = useState(0);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const navigating = useRef(false);
	const pending = useRef<HomepageShowcaseSlide | null>(null);
	const router = useRouter();
	const applyPrompt = useLandingPromptSelection();
	const slide = slides[index];
	const first = slides[0];

	useEffect(() => {
		if (!first || !canAutoShowHomepageShowcase(window.location.search, window.location.hash))
			return;
		try {
			if (localStorage.getItem(HOMEPAGE_SHOWCASE_SEEN_KEY)) return;
		} catch {
			/* Optional preference. */
		}
		let canceled = false;
		// Decode the first pair before entrance so the reveal never starts on an empty frame.
		const images = [first.poster, ...("before" in first ? [first.before] : [])];
		const ready = Promise.allSettled(
			images.map((src) => {
				const img = new Image();
				img.src = src;
				return img.decode();
			}),
		);
		const timer = window.setTimeout(async () => {
			await ready;
			if (
				canceled ||
				document.visibilityState !== "visible" ||
				document.querySelector('[role="dialog"]')
			)
				return;
			if (!canAutoShowHomepageShowcase(window.location.search, window.location.hash)) return;
			returnFocus.current = document.activeElement as HTMLElement | null;
			setOpen(true);
		}, 1400);
		const cancel = () => {
			canceled = true;
			window.clearTimeout(timer);
		};
		window.addEventListener("pointerdown", cancel, { once: true });
		window.addEventListener("keydown", cancel, { once: true });
		return () => {
			cancel();
			window.removeEventListener("pointerdown", cancel);
			window.removeEventListener("keydown", cancel);
		};
	}, [first]);

	useEffect(() => {
		if (!open) return;
		try {
			localStorage.setItem(HOMEPAGE_SHOWCASE_SEEN_KEY, "seen");
		} catch {
			/* Optional preference. */
		}
	}, [open]);
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
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (value) {
					navigating.current = false;
					returnFocus.current = document.activeElement as HTMLElement | null;
				}
				setOpen(value);
			}}
			onOpenChangeComplete={(value) => {
				if (value || !pending.current) return;
				const choice = pending.current;
				pending.current = null;
				if (!choice.prompt || !applyPrompt(choice.prompt)) router.push(choice.href);
			}}
		>
			<DialogTrigger className="homepage-showcase-trigger">
				<SparklesIcon size={15} aria-hidden="true" />
				{copy.trigger}
			</DialogTrigger>
			<DialogContent
				className="homepage-showcase"
				closeLabel={copy.close}
				initialFocus={titleRef}
				finalFocus={() => {
					if (!navigating.current) returnFocus.current?.focus({ preventScroll: true });
					return false;
				}}
				overlayProps={{ className: "homepage-showcase-backdrop", "data-test": "showcase-backdrop" }}
				data-test="homepage-showcase"
			>
				<div className="homepage-showcase-media" data-kind={slide.kind}>
					<div className="homepage-showcase-scene" key={slide.key}>
						{slide.kind === "video" ? (
							<ShowcaseVideo slide={slide} copy={copy} active={open} />
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
							<DialogTitle ref={titleRef} tabIndex={-1} className="homepage-showcase-title">
								{slide.title}
							</DialogTitle>
							<DialogDescription className="homepage-showcase-description">
								{slide.description}
							</DialogDescription>
						</div>
						<Link
							href={slide.href}
							prefetch={false}
							className="homepage-showcase-cta"
							data-test="showcase-create"
							onClick={(event) => {
								void trackBrowserGrowthEvent({
									name: "homepage_idea_selected",
									properties: {
										homepageIdea: slide.key,
										homepagePlacement: "showcase",
										status: "selected",
									},
								});
								if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
								navigating.current = true;
								if (slide.prompt) {
									event.preventDefault();
									pending.current = slide;
								}
								setOpen(false);
							}}
						>
							{slide.action}
							<ArrowRightIcon size={17} aria-hidden="true" />
						</Link>
					</div>
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
									<img src={item.poster} alt="" width={56} height={40} loading="lazy" />
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
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ShowcaseImage({
	slide,
	copy,
}: {
	slide: Exclude<HomepageShowcaseSlide, { kind: "video" }>;
	copy: HomepageShowcaseCopy;
}) {
	const [position, setPosition] = useState(50);
	const [interacted, setInteracted] = useState(false);
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
		<div
			className="homepage-showcase-comparison"
			data-reveal={ready >= 2 && !interacted ? "intro" : "manual"}
		>
			<img
				src={slide.before}
				alt={copy.before}
				draggable={false}
				onLoad={() => setReady((value) => value + 1)}
			/>
			<div
				className="homepage-showcase-edited"
				style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
			>
				<img
					src={slide.poster}
					alt={slide.title}
					draggable={false}
					onLoad={() => setReady((value) => value + 1)}
				/>
			</div>
			<div
				className="homepage-showcase-divider"
				style={{ left: `${position}%` }}
				aria-hidden="true"
			>
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
				value={position}
				aria-label={copy.compare}
				aria-valuetext={`${copy.after} ${position}%`}
				onPointerDown={() => setInteracted(true)}
				onKeyDown={() => setInteracted(true)}
				onChange={(event) => {
					setInteracted(true);
					setPosition(Number(event.target.value));
				}}
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
	active,
}: {
	slide: Extract<HomepageShowcaseSlide, { kind: "video" }>;
	active: boolean;
	copy: HomepageShowcaseCopy;
}) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const activeRef = useRef(active);
	activeRef.current = active;
	useEffect(() => {
		if (!active) videoRef.current?.pause();
	}, [active]);
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
			if (
				!activeRef.current ||
				document.visibilityState !== "visible" ||
				motion.matches ||
				userPaused.current
			)
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
			{!playing && active && (
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
