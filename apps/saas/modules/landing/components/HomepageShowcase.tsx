"use client";

import { trackBrowserGrowthEvent } from "@repo/utils/lib/growth-analytics-browser";
import { ConsentBanner } from "@shared/components/ConsentBanner";
import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { SparklesIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";

import {
	canAutoShowHomepageShowcase,
	HOMEPAGE_SHOWCASE_COMPACT_COMPARISON,
	HOMEPAGE_SHOWCASE_COMPACT_QUERY,
	HOMEPAGE_SHOWCASE_DELAY_MS,
	HOMEPAGE_SHOWCASE_PRELOAD_ID,
	type HomepageShowcaseCopy,
	type HomepageShowcaseSlide,
} from "../lib/homepage-showcase";
import {
	mountHomepageShowcase,
	type ShowcaseDialogElement,
	type ShowcasePreloadScript,
} from "../lib/homepage-showcase-browser";
import { LANDING_PROMPT_SELECTED_EVENT } from "../lib/prompt-selection";
import { useLandingPromptSelection } from "../lib/use-landing-prompt-selection";
import { HomepageShowcaseDialogContent } from "./HomepageShowcaseDialog";

import "./homepage-showcase.css";

export function HomepageShowcase({
	slides,
	copy,
}: {
	slides: HomepageShowcaseSlide[];
	copy: HomepageShowcaseCopy;
}) {
	const dialogRef = useRef<ShowcaseDialogElement>(null);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const [enhanced, setEnhanced] = useState(false);
	const [open, setOpen] = useState(false);
	const [index, setIndex] = useState(0);
	const router = useRouter();
	const applyPrompt = useLandingPromptSelection();
	const { policyReady, showBanner } = useCookieConsent();
	const first = slides[0];
	const slide = slides[index];

	const onCreate = useRef<(event: MouseEvent) => void>(undefined);
	useLayoutEffect(() => {
		onCreate.current = (event: MouseEvent) => {
			if (!slide) return;
			void trackBrowserGrowthEvent({
				name: "homepage_idea_selected",
				properties: {
					homepageIdea: slide.key,
					homepagePlacement: "showcase",
					status: "selected",
				},
			});
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			dialogRef.current?.homepageShowcase?.close({
				restoreFocus: false,
				afterClose: () => {
					if (!slide.prompt || !applyPrompt(slide.prompt)) router.push(slide.href);
				},
			});
		};
	}, [applyPrompt, router, slide]);

	useLayoutEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog || !first || first.kind !== "comparison") return;
		const preload = document.getElementById(
			HOMEPAGE_SHOWCASE_PRELOAD_ID,
		) as ShowcasePreloadScript | null;
		const start = preload?.homepageShowcaseStart;
		const fromParser = start?.href === location.href ? start : undefined;
		const canAutoOpen =
			location.pathname === "/" && canAutoShowHomepageShowcase(location.search, location.hash);
		const controller = mountHomepageShowcase(dialog, {
			sources:
				fromParser?.sources ??
				(matchMedia(HOMEPAGE_SHOWCASE_COMPACT_QUERY).matches
					? HOMEPAGE_SHOWCASE_COMPACT_COMPARISON
					: first),
			earliestOpen: canAutoOpen
				? (fromParser?.time ?? performance.now()) + HOMEPAGE_SHOWCASE_DELAY_MS
				: null,
			promptEvent: LANDING_PROMPT_SELECTED_EVENT,
		});
		const disconnect = controller.connect({
			onOpenChange: setOpen,
			onCreate: (event) => onCreate.current?.(event),
		});
		setEnhanced(true);
		return disconnect;
	}, [first]);

	useLayoutEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		// Leave the opening position in place if the privacy policy resolves while this is open.
		if (!dialog.open) dialog.toggleAttribute("data-consent-space", !policyReady || showBanner);
		if (dialog.open) dialog.homepageShowcase?.prepareComparison();
	}, [index, open, policyReady, showBanner]);

	if (!slide) return null;
	return (
		<>
			<button
				type="button"
				className="homepage-showcase-trigger"
				aria-haspopup="dialog"
				aria-controls="homepage-showcase"
			>
				<SparklesIcon size={15} aria-hidden="true" />
				{copy.trigger}
			</button>
			<dialog
				ref={dialogRef}
				id="homepage-showcase"
				className="homepage-showcase"
				aria-labelledby="homepage-showcase-title"
				aria-describedby="homepage-showcase-description"
				data-homepage-showcase={open ? "" : undefined}
				data-consent-space=""
				data-showcase-enhanced={enhanced ? "" : undefined}
				data-test="homepage-showcase"
				suppressHydrationWarning
			>
				<HomepageShowcaseDialogContent
					slides={slides}
					copy={copy}
					index={index}
					setIndex={setIndex}
					open={open}
					showPicker={enhanced && open}
					titleRef={titleRef}
				/>
				{open && <ConsentBanner returnFocus={titleRef} />}
				<button type="button" aria-label={copy.close} data-showcase-close="">
					<XIcon size={18} aria-hidden="true" />
				</button>
			</dialog>
		</>
	);
}
