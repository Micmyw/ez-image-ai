"use client";

import { PauseIcon, PlayIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function AnimatedModelCard({
	href,
	name,
	tag,
	lead,
	poster,
	animation,
	alt,
}: {
	href: string;
	name: string;
	tag: string;
	lead: string;
	poster: string;
	animation: string;
	alt: string;
}) {
	const root = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [pageVisible, setPageVisible] = useState(true);
	const [reducedMotion, setReducedMotion] = useState(true);
	const [userPlaying, setUserPlaying] = useState<boolean | null>(null);
	const [failed, setFailed] = useState(false);
	const playing = visible && pageVisible && !failed && (userPlaying ?? !reducedMotion);

	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const updateMotion = () => setReducedMotion(motion.matches);
		const updateVisibility = () => setPageVisible(!document.hidden);
		updateMotion();
		updateVisibility();
		const observer = new IntersectionObserver(
			([entry]) => setVisible(Boolean(entry?.isIntersecting)),
			{ threshold: 0.2 },
		);
		observer.observe(element);
		motion.addEventListener("change", updateMotion);
		document.addEventListener("visibilitychange", updateVisibility);
		return () => {
			observer.disconnect();
			motion.removeEventListener("change", updateMotion);
			document.removeEventListener("visibilitychange", updateVisibility);
		};
	}, []);

	return (
		<div ref={root} className="min-w-0 relative" data-model-animation={name}>
			<Link
				href={href}
				prefetch={false}
				className="group focus-visible:outline-violet-300 block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4"
			>
				<div className="aspect-[3/2] overflow-hidden rounded-xl bg-[#250647]">
					<img
						src={playing ? animation : poster}
						alt={alt}
						width={512}
						height={512}
						loading="lazy"
						decoding="async"
						className="h-full w-full object-contain"
						onError={() => setFailed(true)}
					/>
				</div>
				<div className="pt-5">
					<p className="text-xs text-violet-300">{tag}</p>
					<h3 className="mt-2 text-xl font-semibold text-white">{name}</h3>
					<p className="mt-2 text-sm leading-6 text-[#b7acbf]">{lead}</p>
				</div>
			</Link>
			{visible && !failed && (
				<button
					type="button"
					onClick={() => setUserPlaying(!playing)}
					aria-label={`${playing ? "Pause" : "Play"} ${name} animation`}
					className="right-3 top-3 size-10 border-white/25 bg-black/65 text-white hover:bg-black/85 focus-visible:outline-violet-300 absolute flex items-center justify-center rounded-full border focus-visible:outline-2 focus-visible:outline-offset-4"
				>
					{playing ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
				</button>
			)}
		</div>
	);
}
