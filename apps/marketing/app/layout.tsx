import { config } from "@config";
import { getBaseUrl, parseGoogleSiteVerification } from "@shared/lib/base-url";
import type { Metadata } from "next";
import type { PropsWithChildren } from "react";

import "./globals.css";

export const metadata: Metadata = {
	applicationName: config.appName,
	description: config.appDescription,
	metadataBase: new URL(getBaseUrl()),
	robots: { index: false, follow: true },
	...(parseGoogleSiteVerification(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION)
		? {
				verification: {
					google: parseGoogleSiteVerification(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION),
				},
			}
		: {}),
	openGraph: {
		description: config.appDescription,
		siteName: config.appName,
		title: config.appName,
		type: "website",
	},
	title: {
		absolute: config.appName,
		default: config.appName,
		template: `%s | ${config.appName}`,
	},
};

export default function RootLayout({ children }: PropsWithChildren) {
	return children;
}
