"use client";

import type { HomepageBirthdayVariant } from "@repo/config/homepage-ideas";
import { trackBrowserGrowthEvent } from "@repo/utils/lib/growth-analytics-browser";
import Link from "next/link";
import { type MouseEvent, type ReactNode } from "react";

import type { QuickStartIdea } from "../lib/quick-start-ideas";
import { useLandingPromptSelection } from "../lib/use-landing-prompt-selection";

export function QuickStartAction({
	idea,
	href,
	prompt,
	variant,
	children,
}: {
	idea: QuickStartIdea;
	href: string;
	prompt?: string;
	variant?: HomepageBirthdayVariant;
	children: ReactNode;
}) {
	const applyPrompt = useLandingPromptSelection();
	function select(event: MouseEvent<HTMLAnchorElement>) {
		void trackBrowserGrowthEvent({
			name: "homepage_idea_selected",
			properties: {
				homepageIdea: idea,
				homepagePlacement: "quick-start",
				...(variant ? { homepageVariant: variant } : {}),
				status: "selected",
			},
		});
		if (!prompt || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		if (applyPrompt(prompt)) event.preventDefault();
	}

	return (
		<Link
			href={href}
			prefetch={false}
			className="quick-start-card"
			data-quick-start={idea}
			data-homepage-variant={variant}
			onClick={select}
		>
			{children}
		</Link>
	);
}
