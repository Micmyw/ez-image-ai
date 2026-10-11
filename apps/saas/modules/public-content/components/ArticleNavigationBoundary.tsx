"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef } from "react";

import {
	getArticleDocumentNavigationTarget,
	isBlogAdArticlePath,
	requiresArticleDocumentNavigation,
} from "../lib/blog-ad-routing";

/** Navigation only: no advertising requests, scripts, credentials or form handling. */
export function ArticleNavigationBoundary() {
	const pathname = usePathname();
	const documentPathname = useRef<string | null>(null);
	const navigating = useRef(false);

	useLayoutEffect(() => {
		// Navigation timing retains the loaded document URL after history.pushState.
		// Store only its path; do not retain or transmit query/account/media values.
		const navigation = performance.getEntriesByType("navigation")[0];
		let loadedPathname = window.location.pathname;
		if (navigation) {
			try {
				const loaded = new URL(navigation.name);
				if (loaded.origin === window.location.origin) loadedPathname = loaded.pathname;
			} catch {
				// An unavailable navigation entry falls back to the initial location.
			}
		}
		documentPathname.current ??= loadedPathname;

		const clearFrames = () => {
			for (const frame of document.querySelectorAll<HTMLIFrameElement>(
				"iframe[data-blog-ad-frame]",
			)) {
				frame.removeAttribute("srcdoc");
				frame.src = "about:blank";
				frame.remove();
			}
		};
		const reloadAcrossBoundary = () => {
			if (
				navigating.current ||
				!documentPathname.current ||
				!requiresArticleDocumentNavigation(documentPathname.current, window.location.pathname)
			)
				return false;
			navigating.current = true;
			clearFrames();
			window.location.reload();
			return true;
		};
		const onClick = (event: MouseEvent) => {
			if (!(event.target instanceof Element)) return;
			const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
			if (!anchor) return;
			const destination = getArticleDocumentNavigationTarget(window.location.href, anchor.href, {
				button: event.button,
				defaultPrevented: event.defaultPrevented,
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				shiftKey: event.shiftKey,
				target: anchor.getAttribute("target"),
				download: anchor.hasAttribute("download"),
				disabled: anchor.getAttribute("aria-disabled") === "true",
			});
			if (!destination) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (navigating.current) return;
			navigating.current = true;
			clearFrames();
			window.location.assign(destination);
		};
		const onPopState = (event: PopStateEvent) => {
			// Capture precedes Next's history restore so it cannot reuse the old CSP.
			if (reloadAcrossBoundary()) event.stopImmediatePropagation();
		};
		const onPageShow = (event: PageTransitionEvent) => {
			// A BFCache restore resumes this document's original response policy.
			if (!event.persisted) return;
			navigating.current = false;
			clearFrames();
			reloadAcrossBoundary();
		};
		document.addEventListener("click", onClick, true);
		window.addEventListener("popstate", onPopState, true);
		window.addEventListener("pagehide", clearFrames);
		window.addEventListener("pageshow", onPageShow);
		return () => {
			if (isBlogAdArticlePath(window.location.pathname)) clearFrames();
			document.removeEventListener("click", onClick, true);
			window.removeEventListener("popstate", onPopState, true);
			window.removeEventListener("pagehide", clearFrames);
			window.removeEventListener("pageshow", onPageShow);
		};
	}, []);

	useLayoutEffect(() => {
		// Next router.push/replace and native history changes update usePathname.
		// This fallback reloads the new URL when a programmatic transition escaped
		// the anchor capture; a SPA response cannot change a document's CSP.
		if (
			!pathname ||
			!documentPathname.current ||
			navigating.current ||
			!requiresArticleDocumentNavigation(documentPathname.current, pathname)
		)
			return;
		navigating.current = true;
		for (const frame of document.querySelectorAll<HTMLIFrameElement>(
			"iframe[data-blog-ad-frame]",
		)) {
			frame.removeAttribute("srcdoc");
			frame.src = "about:blank";
			frame.remove();
		}
		window.location.reload();
	}, [pathname]);

	return null;
}
