"use client";

import { HOMEPAGE_BIRTHDAY_VARIANTS } from "@repo/config/homepage-ideas";
import { ArrowUpRightIcon, ImageIcon, PauseIcon, PlayIcon } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import type { QuickStartIdea } from "../lib/quick-start-ideas";
import { QuickStartAction } from "./QuickStartAction";

export type QuickStartCardData = {
	key: QuickStartIdea;
	href: string;
	image: string;
	prompt?: string;
	video: boolean;
	title: string;
	description: string;
	input: string;
	action: string;
	alt: string;
	kind: string;
	birthday?: {
		portraitAlt: string;
		portraitLabel: string;
		dogLabel: string;
		pause: string;
		play: string;
	};
};

/** Compact data props avoid serializing each card's entire element tree into the document. */
export function QuickStartCard({ card }: { card: QuickStartCardData }) {
	const root = useRef<HTMLDivElement>(null);
	const [index, setIndex] = useState(0);
	const [visible, setVisible] = useState(false);
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const interacting = hovered || focused;
	const [paused, setPaused] = useState(false);
	const [ready, setReady] = useState<Record<string, boolean>>({});
	const birthday = card.birthday;
	const bothReady = ready.portrait && ready.dog;

	useEffect(() => {
		if (!birthday || !root.current) return;
		const observer = new IntersectionObserver(
			([entry]) => setVisible(Boolean(entry && entry.intersectionRatio >= 0.5)),
			{ threshold: 0.5 },
		);
		observer.observe(root.current);
		return () => observer.disconnect();
	}, [birthday]);

	useEffect(() => {
		if (!birthday || !visible || interacting || paused || !bothReady) return;
		const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
		let timer: ReturnType<typeof setInterval> | undefined;
		const schedule = () => {
			clearInterval(timer);
			if (!motion.matches && document.visibilityState === "visible") {
				timer = setInterval(() => setIndex((current) => 1 - current), 8000);
			}
		};
		schedule();
		document.addEventListener("visibilitychange", schedule);
		motion.addEventListener("change", schedule);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", schedule);
			motion.removeEventListener("change", schedule);
		};
	}, [birthday, visible, interacting, paused, bothReady]);

	return (
		<div
			ref={root}
			className="quick-start-card-wrap"
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
			onFocusCapture={() => setFocused(true)}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
			}}
		>
			<QuickStartAction
				idea={card.key}
				href={card.href}
				prompt={card.prompt}
				variant={birthday ? HOMEPAGE_BIRTHDAY_VARIANTS[index] : undefined}
			>
				<div className={`quick-start-art quick-start-art--${card.key}`}>
					{birthday ? (
						[
							{
								key: "portrait",
								src: "/examples/case-birthday-portrait.webp",
								alt: birthday.portraitAlt,
							},
							{ key: "dog", src: card.image, alt: card.alt },
						].map((image, position) => (
							<span
								key={image.key}
								className="birthday-preview-frame"
								data-active={position === index}
								aria-hidden={position !== index}
							>
								<Image
									src={image.src}
									alt={image.alt}
									fill
									sizes="(min-width: 1280px) 23vw, (min-width: 768px) 35vw, 46vw"
									loading="lazy"
									onLoad={() => setReady((current) => ({ ...current, [image.key]: true }))}
								/>
							</span>
						))
					) : (
						<Image
							src={card.image}
							alt={card.alt}
							fill
							sizes="(min-width: 1280px) 23vw, (min-width: 768px) 35vw, 46vw"
							loading="lazy"
						/>
					)}
					{!birthday && (
						<span className="quick-start-kind">
							{card.video ? (
								<PlayIcon size={12} aria-hidden="true" />
							) : (
								<ImageIcon size={12} aria-hidden="true" />
							)}
							{card.kind}
						</span>
					)}
					<span className="quick-start-input">{card.input}</span>
				</div>
				<div className="quick-start-copy">
					<h3>{card.title}</h3>
					<p>{card.description}</p>
					<span className="quick-start-cta">
						{card.action}
						<ArrowUpRightIcon size={17} aria-hidden="true" />
					</span>
				</div>
			</QuickStartAction>
			{birthday && (
				<div className="birthday-preview-controls">
					{[birthday.portraitLabel, birthday.dogLabel].map((label, position) => (
						<button
							key={label}
							type="button"
							aria-label={label}
							aria-pressed={index === position}
							onClick={() => {
								setIndex(position);
								setPaused(true);
							}}
						>
							<span />
						</button>
					))}
					<button
						type="button"
						aria-label={paused ? birthday.play : birthday.pause}
						onClick={() => setPaused(!paused)}
					>
						{paused ? (
							<PlayIcon size={13} aria-hidden="true" />
						) : (
							<PauseIcon size={13} aria-hidden="true" />
						)}
					</button>
				</div>
			)}
		</div>
	);
}
