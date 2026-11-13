"use client";

import { GlowSurface } from "@repo/ui/components/glow-surface";
import { useEffect, useRef } from "react";

const videoSource = "/images/models/seedream-5-5/media-io-demo.mp4";

export function SeedreamDemo() {
	const videoRef = useRef<HTMLVideoElement>(null);
	const userPaused = useRef(false);
	const automaticPauses = useRef(0);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		let visible = false;
		const syncPlayback = () => {
			if (visible && !video.getAttribute("src")) video.src = videoSource;
			if (!visible || document.hidden || motion.matches || userPaused.current) {
				if (!video.paused) {
					automaticPauses.current += 1;
					video.pause();
				}
			} else {
				void video.play().catch(() => {});
			}
		};
		const observer = new IntersectionObserver(
			([entry]) => {
				visible = Boolean(entry?.isIntersecting);
				syncPlayback();
			},
			{ threshold: 0.2 },
		);
		observer.observe(video);
		document.addEventListener("visibilitychange", syncPlayback);
		motion.addEventListener("change", syncPlayback);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", syncPlayback);
			motion.removeEventListener("change", syncPlayback);
			if (!video.paused) {
				automaticPauses.current += 1;
				video.pause();
			}
			video.removeAttribute("src");
			video.load();
		};
	}, []);

	return (
		<figure className="seedream-demo" data-seedream-demo="">
			<GlowSurface variant="frame" tone="cyan" radius="1rem" className="seedream-demo-frame">
				{/* The source has no supplied caption track; adjacent text describes the visual edits. */}
				{/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
				<video
					ref={videoRef}
					poster="/images/models/seedream-5-5/media-io-demo-poster.jpg"
					width={1200}
					height={676}
					muted
					loop
					playsInline
					controls
					preload="none"
					aria-label="Seedream 5.5 editing demo"
					onPlay={() => {
						userPaused.current = false;
					}}
					onPause={() => {
						// A later play event must not erase an automatic pause still queued by the browser.
						if (automaticPauses.current > 0) automaticPauses.current -= 1;
						else userPaused.current = true;
					}}
				/>
			</GlowSurface>
			<figcaption>
				<div>
					<h3>One photo. A new look with every edit.</h3>
					<p>Explore changes to eyewear, clothing, colors and details in this short demo.</p>
				</div>
				<a href="https://www.media.io/" target="_blank" rel="noreferrer">
					Demo: Media.io ↗
				</a>
			</figcaption>
		</figure>
	);
}
