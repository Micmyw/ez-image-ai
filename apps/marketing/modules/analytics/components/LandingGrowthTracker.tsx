"use client";

import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { useEffect } from "react";

import { marketingGrowthFunnel } from "../growth";

export function LandingGrowthTracker() {
	const { userHasConsented } = useCookieConsent();

	useEffect(() => {
		if (userHasConsented) void marketingGrowthFunnel.landingViewed();
	}, [userHasConsented]);

	return null;
}
