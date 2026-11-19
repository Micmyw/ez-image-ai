"use client";

import { useServerInsertedHTML } from "next/navigation";
import { useRef } from "react";

import {
	allowsHomepageShowcaseQuery,
	HOMEPAGE_SHOWCASE_COMPACT_COMPARISON,
	HOMEPAGE_SHOWCASE_COMPACT_QUERY,
	HOMEPAGE_SHOWCASE_DELAY_MS,
	HOMEPAGE_SHOWCASE_KEYS,
	HOMEPAGE_SHOWCASE_MEDIA,
	HOMEPAGE_SHOWCASE_PRELOAD_ID,
} from "../lib/homepage-showcase";
import { mountHomepageShowcase } from "../lib/homepage-showcase-browser";
import { LANDING_PROMPT_SELECTED_EVENT } from "../lib/prompt-selection";

const firstShowcase = HOMEPAGE_SHOWCASE_MEDIA[HOMEPAGE_SHOWCASE_KEYS[0]];

// Only the document knows its fragment. Select a pair once for both preloading and display.
const startupScript = `(() => {
	if (location.pathname !== "/" || location.hash ||
		!(${allowsHomepageShowcaseQuery.toString()})(new URLSearchParams(location.search).keys())) return;
	const script = document.getElementById(${JSON.stringify(HOMEPAGE_SHOWCASE_PRELOAD_ID)});
	if (!script || script.homepageShowcaseStart || document.getElementById('homepage-showcase')?.homepageShowcase) return;
	const sources = matchMedia(${JSON.stringify(HOMEPAGE_SHOWCASE_COMPACT_QUERY)}).matches
		? ${JSON.stringify(HOMEPAGE_SHOWCASE_COMPACT_COMPARISON)}
		: ${JSON.stringify({ before: firstShowcase.before, poster: firstShowcase.poster })};
	const start = { href: location.href, time: performance.now(), sources };
	script.homepageShowcaseStart = start;
	for (const href of [sources.before, sources.poster]) {
		const link = document.createElement("link");
		link.rel = "preload";
		link.as = "image";
		link.fetchPriority = "high";
		link.href = href;
		document.head.append(link);
	}
	const activate = () => {
		const dialog = document.getElementById('homepage-showcase');
		if (!dialog?.querySelector('[data-showcase-close]') || dialog.closest('[hidden]')) return;
		observer.disconnect();
		if (location.href !== start.href) return;
		(${mountHomepageShowcase.toString()})(dialog, {
			sources,
			earliestOpen: start.time + ${HOMEPAGE_SHOWCASE_DELAY_MS},
			promptEvent: ${JSON.stringify(LANDING_PROMPT_SELECTED_EVENT)},
		});
	};
	const observer = new MutationObserver(activate);
	observer.observe(document.documentElement, { childList: true, subtree: true });
	activate();
})();`.replaceAll(/<\/script/gi, "<\\/script");

export function HomepageShowcaseStartup() {
	const inserted = useRef(false);
	// The script belongs to the initial HTML stream, not the RSC payload or a client transition.
	// An async module can execute while the earlier stylesheets are still downloading.
	useServerInsertedHTML(() => {
		if (inserted.current) return null;
		inserted.current = true;
		return (
			<script
				id={HOMEPAGE_SHOWCASE_PRELOAD_ID}
				type="module"
				async
				dangerouslySetInnerHTML={{ __html: startupScript }}
			/>
		);
	});
	return null;
}
