"use client";

import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import {
	BLOG_AD_BANNER_WIDTH,
	BLOG_AD_NATIVE_HEIGHT,
	BLOG_AD_SANDBOX,
	getBlogAdDocumentUrl,
	type BlogAdFormat,
	type BlogAdSettings,
} from "../lib/blog-ads";

import "./blog-ads.css";

export function BlogAds({ settings }: { settings: BlogAdSettings }) {
	const t = useTranslations("guides.ads");
	const { userHasConsented } = useCookieConsent();
	const [requested, setRequested] = useState(false);
	const root = useRef<HTMLElement>(null);

	useEffect(() => {
		if (!userHasConsented) setRequested(false);
	}, [userHasConsented]);

	useEffect(() => {
		// Also reset when React reactivates a cached article after SPA history navigation.
		setRequested(false);
		const pause = () => {
			// Clear the browsing contexts synchronously before the page enters BFCache.
			for (const frame of root.current?.querySelectorAll("iframe") ?? []) {
				frame.removeAttribute("srcdoc");
				frame.src = "about:blank";
			}
			setRequested(false);
		};
		window.addEventListener("pagehide", pause);
		window.addEventListener("pageshow", pause);
		return () => {
			pause();
			window.removeEventListener("pagehide", pause);
			window.removeEventListener("pageshow", pause);
		};
	}, []);

	if (!settings.enabled) return null;
	const active = userHasConsented && requested;
	return (
		<section ref={root} data-blog-ads="" aria-label={t("label")} className="blog-ads">
			<div className="blog-ads-controls">
				<p>{t("notice")}</p>
				<a href="/privacy">{t("privacy")}</a>
				{userHasConsented && (
					<button type="button" onClick={() => setRequested(!requested)}>
						{t(active ? "hide" : "show")}
					</button>
				)}
			</div>
			<AdFrame format="banner" active={active} title={t("banner")} label={t("label")} />
			{settings.nativeEnabled && (
				<AdFrame format="native" active={active} title={t("native")} label={t("label")} />
			)}
		</section>
	);
}

function AdFrame({
	format,
	active,
	title,
	label,
}: {
	format: BlogAdFormat;
	active: boolean;
	title: string;
	label: string;
}) {
	const slot = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const [fits, setFits] = useState(format !== "banner");
	const [nearby, setNearby] = useState(false);
	useEffect(() => {
		const element = slot.current;
		if (!element) return;
		const resize = new ResizeObserver(([entry]) =>
			setFits(format !== "banner" || (entry?.contentRect.width ?? 0) >= BLOG_AD_BANNER_WIDTH),
		);
		const visibility = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) {
					setNearby(true);
					visibility.disconnect();
				}
			},
			{ rootMargin: "200px" },
		);
		resize.observe(element);
		visibility.observe(element);
		return () => {
			resize.disconnect();
			visibility.disconnect();
		};
	}, [format]);
	useEffect(() => {
		if (!active || !fits || !nearby || !content.current) return;
		// React owns the container; this effect owns the complete isolated context.
		// Cleanup also runs when an Activity/cache hides the article without removing its DOM.
		const frame = document.createElement("iframe");
		frame.dataset.blogAdFrame = format;
		frame.title = title;
		frame.setAttribute("sandbox", BLOG_AD_SANDBOX);
		frame.referrerPolicy = "no-referrer";
		frame.loading = "lazy";
		frame.width = format === "banner" ? String(BLOG_AD_BANNER_WIDTH) : "100%";
		frame.height = format === "banner" ? "90" : String(BLOG_AD_NATIVE_HEIGHT);
		frame.src = getBlogAdDocumentUrl(format);
		content.current.appendChild(frame);
		return () => {
			frame.removeAttribute("srcdoc");
			frame.src = "about:blank";
			frame.remove();
		};
	}, [active, fits, nearby, format, title]);
	return (
		<div ref={slot} data-blog-ad={format} className={`blog-ad blog-ad-${format}`}>
			<span className="blog-ad-label">{label}</span>
			<div ref={content} className="blog-ad-content" />
		</div>
	);
}
