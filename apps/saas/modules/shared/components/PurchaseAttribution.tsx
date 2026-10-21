"use client";

import { useCookieConsent } from "@shared/hooks/cookie-consent";
import {
	captureCheckoutTrigger,
	captureRegistrationFirstTouch,
	clearPurchaseAttribution,
	preparePurchaseAttribution,
} from "@shared/lib/purchase-attribution";
import { useEffect } from "react";

export function PurchaseAttribution() {
	const { analyticsAllowed, policyReady } = useCookieConsent();
	useEffect(() => {
		preparePurchaseAttribution();
	}, []);
	useEffect(() => {
		if (analyticsAllowed) void captureRegistrationFirstTouch();
		else if (policyReady) clearPurchaseAttribution();
	}, [analyticsAllowed, policyReady]);
	useEffect(() => {
		function capture(event: MouseEvent) {
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
				return;
			const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
			if (!anchor || anchor.hasAttribute("target") || anchor.hasAttribute("download")) return;
			let url: URL;
			try {
				url = new URL(anchor.getAttribute("href") ?? "", window.location.href);
			} catch {
				return;
			}
			if (url.origin !== window.location.origin) return;
			if (url.pathname === "/pricing" || url.pathname === "/choose-plan" || url.hash === "#pricing")
				captureCheckoutTrigger();
		}
		document.addEventListener("click", capture, true);
		return () => document.removeEventListener("click", capture, true);
	}, []);
	return null;
}
