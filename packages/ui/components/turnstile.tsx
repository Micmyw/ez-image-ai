"use client";

import { useEffect, useRef } from "react";

import { cn } from "../lib";

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
	render(
		container: HTMLElement,
		options: {
			sitekey: string;
			action: string;
			callback: (token: string) => void;
			"error-callback": () => void;
			"expired-callback": () => void;
			theme: "auto";
		},
	): string;
	remove(widgetId: string): void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

export function Turnstile({
	siteKey,
	action,
	ariaLabel,
	className,
	onToken,
	onError,
	onExpire,
}: {
	siteKey: string;
	action: string;
	ariaLabel: string;
	className?: string;
	onToken: (token: string) => void;
	onError?: () => void;
	onExpire?: () => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const callbacks = useRef({ onToken, onError, onExpire });
	callbacks.current = { onToken, onError, onExpire };

	useEffect(() => {
		let disposed = false;
		let widgetId: string | undefined;
		const renderWidget = () => {
			if (disposed || !containerRef.current || !window.turnstile || widgetId) return;
			widgetId = window.turnstile.render(containerRef.current, {
				sitekey: siteKey,
				action,
				theme: "auto",
				callback: (token) => callbacks.current.onToken(token),
				"error-callback": () => callbacks.current.onError?.(),
				"expired-callback": () => callbacks.current.onExpire?.(),
			});
		};

		if (window.turnstile) {
			renderWidget();
		} else {
			const existing = document.querySelector<HTMLScriptElement>(
				`script[src="${TURNSTILE_SCRIPT}"]`,
			);
			const script = existing ?? document.createElement("script");
			if (!existing) {
				script.src = TURNSTILE_SCRIPT;
				script.async = true;
				script.defer = true;
				document.head.append(script);
			}
			script.addEventListener("load", renderWidget);
			return () => {
				disposed = true;
				script.removeEventListener("load", renderWidget);
				if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
			};
		}

		return () => {
			disposed = true;
			if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
		};
	}, [action, siteKey]);

	return (
		<div ref={containerRef} className={cn("min-h-[65px]", className)} aria-label={ariaLabel} />
	);
}
