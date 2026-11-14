"use client";

import { SparklesIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import {
	canAutoShowHomepageShowcase,
	type HomepageShowcaseCopy,
	type HomepageShowcaseSlide,
} from "../lib/homepage-showcase";

import "./homepage-showcase.css";

const ShowcaseDialog = lazy(() =>
	import("./HomepageShowcaseDialog").then((module) => ({ default: module.HomepageShowcaseDialog })),
);

/** Keep preview scenes and player controls out of the editor's initial download. */
export function HomepageShowcase({
	slides,
	copy,
}: {
	slides: HomepageShowcaseSlide[];
	copy: HomepageShowcaseCopy;
}) {
	const [requested, setRequested] = useState(false);
	const returnFocus = useRef<HTMLElement | null>(null);
	const first = slides[0];
	function open() {
		returnFocus.current = document.activeElement as HTMLElement | null;
		setRequested(true);
	}
	useEffect(() => {
		if (
			requested ||
			!first ||
			!canAutoShowHomepageShowcase(window.location.search, window.location.hash)
		)
			return;
		let canceled = false;
		const ready = Promise.allSettled(
			[first.poster, ...("before" in first ? [first.before] : [])].map((src) => {
				const image = new Image();
				image.src = src;
				return image.decode();
			}),
		);
		let delayElapsed = false;
		let timer: number;
		const reveal = async () => {
			if (!delayElapsed) return;
			await ready;
			if (canceled || document.visibilityState !== "visible") return;
			if (!canAutoShowHomepageShowcase(window.location.search, window.location.hash)) return;
			if (document.querySelector('[role="dialog"]')) {
				timer = window.setTimeout(() => void reveal(), 500);
				return;
			}
			open();
		};
		timer = window.setTimeout(() => {
			delayElapsed = true;
			void reveal();
		}, 1400);
		document.addEventListener("visibilitychange", reveal);
		return () => {
			canceled = true;
			window.clearTimeout(timer);
			document.removeEventListener("visibilitychange", reveal);
		};
	}, [first, requested]);
	if (!first) return null;
	const trigger = (
		<button
			type="button"
			className="homepage-showcase-trigger"
			onClick={open}
			aria-haspopup="dialog"
		>
			<SparklesIcon size={15} aria-hidden="true" />
			{copy.trigger}
		</button>
	);
	return requested ? (
		<Suspense fallback={trigger}>
			<ShowcaseDialog slides={slides} copy={copy} returnFocusTarget={returnFocus.current} />
		</Suspense>
	) : (
		trigger
	);
}
