"use client";

import { invalidatePendingBrowserGrowthAnalytics } from "@repo/utils/lib/growth-analytics-browser";
import Cookies from "js-cookie";
import { createContext, useState } from "react";

import { clearPurchaseAttribution } from "../lib/purchase-attribution";

export type ConsentStatus = "accepted" | "declined" | "undecided";

export const ConsentContext = createContext<{
	consentStatus: ConsentStatus;
	userHasConsented: boolean;
	allowCookies: () => void;
	declineCookies: () => void;
}>({
	consentStatus: "undecided",
	userHasConsented: false,
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

	const allowCookies = () => {
		Cookies.set("consent", "true", { expires: 30 });
		setConsentStatus("accepted");
	};

	const declineCookies = () => {
		Cookies.set("consent", "false", { expires: 30 });
		invalidatePendingBrowserGrowthAnalytics();
		clearPurchaseAttribution();
		setConsentStatus("declined");
	};

	return (
		<ConsentContext.Provider
			value={{
				consentStatus,
				userHasConsented: consentStatus === "accepted",
				allowCookies,
				declineCookies,
			}}
		>
			{children}
		</ConsentContext.Provider>
	);
}
