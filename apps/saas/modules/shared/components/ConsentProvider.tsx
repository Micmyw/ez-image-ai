"use client";

import {
	ANALYTICS_CONSENT_VERSION,
	browserAnalyticsPrivacySignal,
} from "@repo/utils/lib/analytics-policy";
import { invalidatePendingBrowserGrowthAnalytics } from "@repo/utils/lib/growth-analytics-browser";
import {
	EZPIC_ANALYTICS_SESSION_COOKIE,
	EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY,
} from "@repo/utils/lib/growth-analytics-cookie";
import Cookies from "js-cookie";
import { createContext, useEffect, useState } from "react";

import { clearVendorAnalyticsCookies } from "../lib/analytics-cookie-cleanup";
import { clearPurchaseAttribution } from "../lib/purchase-attribution";
import { withdrawSiteAnalyticsConsent } from "../lib/site-analytics";

export type ConsentStatus = "accepted" | "declined" | "undecided";

export const ConsentContext = createContext<{
	consentStatus: ConsentStatus;
	userHasConsented: boolean;
	analyticsAllowed: boolean;
	aggregateAllowed: boolean;
	policyReady: boolean;
	showBanner: boolean;
	preferencesOpen: boolean;
	privacySignal: boolean;
	openPreferences: () => void;
	closePreferences: () => void;
	allowCookies: () => void;
	declineCookies: () => void;
}>({
	consentStatus: "undecided",
	userHasConsented: false,
	analyticsAllowed: false,
	aggregateAllowed: false,
	policyReady: false,
	showBanner: false,
	preferencesOpen: false,
	privacySignal: false,
	openPreferences: () => {},
	closePreferences: () => {},
	allowCookies: () => {},
	declineCookies: () => {},
});

export function ConsentProvider({
	children,
	initialConsentStatus = "undecided",
}: {
	children: React.ReactNode;
	initialConsentStatus?: ConsentStatus;
}) {
	const [consentStatus, setConsentStatus] = useState<ConsentStatus>(initialConsentStatus);
	const [policy, setPolicy] = useState<{ requiresOptIn: boolean; privacySignal: boolean } | null>(
		null,
	);
	const [preferencesOpen, setPreferencesOpen] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const cookieOptions = {
		expires: 30,
		path: "/",
		sameSite: "Lax" as const,
		secure: typeof location !== "undefined" && location.protocol === "https:",
	};
	useEffect(() => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 4000);
		let active = true;
		if (Cookies.get("consent") === "regional") Cookies.remove("consent", { path: "/" });
		void fetch("/api/analytics/policy", {
			cache: "no-store",
			credentials: "same-origin",
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) throw new Error("ANALYTICS_POLICY_UNAVAILABLE");
				const value: unknown = await response.json();
				if (
					!value ||
					typeof value !== "object" ||
					!("requiresOptIn" in value) ||
					typeof value.requiresOptIn !== "boolean" ||
					!("privacySignal" in value) ||
					typeof value.privacySignal !== "boolean"
				)
					throw new Error("ANALYTICS_POLICY_INVALID");
				return {
					requiresOptIn: value.requiresOptIn,
					privacySignal: value.privacySignal || browserAnalyticsPrivacySignal(),
				};
			})
			.catch(() => ({ requiresOptIn: true, privacySignal: browserAnalyticsPrivacySignal() }))
			.then((value) => {
				if (!active) return;
				// Re-read the choice so a delayed response cannot overwrite a refusal.
				const explicitChoice =
					Cookies.get("consent") === "true" &&
					Cookies.get("consent_version") === ANALYTICS_CONSENT_VERSION;
				setConsentStatus(
					Cookies.get("consent") === "false"
						? "declined"
						: explicitChoice
							? "accepted"
							: "undecided",
				);
				if (
					!value.requiresOptIn &&
					!value.privacySignal &&
					Cookies.get("consent") !== "false" &&
					!explicitChoice
				) {
					Cookies.set("consent", "regional", {
						expires: 1,
						path: "/",
						sameSite: "Lax",
						secure: location.protocol === "https:",
					});
					Cookies.set("consent_version", ANALYTICS_CONSENT_VERSION, {
						expires: 30,
						path: "/",
						sameSite: "Lax",
						secure: location.protocol === "https:",
					});
				}
				setPolicy(value);
			})
			.finally(() => clearTimeout(timeout));
		return () => {
			active = false;
			clearTimeout(timeout);
			controller.abort();
		};
	}, []);

	const allowCookies = () => {
		Cookies.set("consent_version", ANALYTICS_CONSENT_VERSION, cookieOptions);
		Cookies.set("consent", "true", cookieOptions);
		setConsentStatus("accepted");
		setPreferencesOpen(false);
	};

	const declineCookies = () => {
		Cookies.set("consent", "false", cookieOptions);
		Cookies.set("consent_version", ANALYTICS_CONSENT_VERSION, cookieOptions);
		withdrawSiteAnalyticsConsent(window);
		clearVendorAnalyticsCookies(window);
		Cookies.remove(EZPIC_ANALYTICS_SESSION_COOKIE, { path: "/" });
		try {
			window.sessionStorage.removeItem(EZPIC_CONTENT_ATTRIBUTION_STORAGE_KEY);
		} catch {
			/* Optional storage may be disabled. */
		}
		invalidatePendingBrowserGrowthAnalytics();
		clearPurchaseAttribution();
		setConsentStatus("declined");
		setPreferencesOpen(false);
	};

	return (
		<ConsentContext.Provider
			value={{
				consentStatus,
				userHasConsented: consentStatus === "accepted" && !!policy && !policy.privacySignal,
				analyticsAllowed:
					!!policy &&
					!policy.privacySignal &&
					consentStatus !== "declined" &&
					(consentStatus === "accepted" || !policy.requiresOptIn),
				aggregateAllowed: !!policy && !policy.privacySignal && consentStatus !== "declined",
				policyReady: !!policy,
				preferencesOpen,
				showBanner:
					preferencesOpen ||
					(!dismissed &&
						!!policy &&
						!policy.privacySignal &&
						policy.requiresOptIn &&
						consentStatus === "undecided"),
				privacySignal: policy?.privacySignal ?? false,
				openPreferences: () => setPreferencesOpen(true),
				closePreferences: () => {
					setPreferencesOpen(false);
					setDismissed(true);
				},
				allowCookies,
				declineCookies,
			}}
		>
			{children}
		</ConsentContext.Provider>
	);
}
