import { getPublicConfig } from "@repo/config/client";

import type { SaasConfig } from "./types";

const publicProductConfig = getPublicConfig();
const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim();

export const config = {
	appName: process.env.NEXT_PUBLIC_SITE_NAME?.trim() || publicProductConfig.brand.siteName,
	appDescription:
		process.env.NEXT_PUBLIC_SITE_DESCRIPTION?.trim() || publicProductConfig.brand.siteDescription,
	saasUrl: process.env.NEXT_PUBLIC_SAAS_URL as string | undefined,
	...(supportEmail ? { supportEmail } : {}),
	enabledThemes: ["light", "dark"],
	defaultTheme: "light",
	redirectAfterSignIn: "/create",
	redirectAfterLogout: "/login",
} as const satisfies SaasConfig;
