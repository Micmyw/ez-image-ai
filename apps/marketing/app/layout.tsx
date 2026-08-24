import { config } from "@config";
import { getBaseUrl } from "@shared/lib/base-url";
import type { Metadata } from "next";
import type { PropsWithChildren } from "react";

import "./globals.css";

export const metadata: Metadata = {
	applicationName: config.appName,
	description: config.appDescription,
	metadataBase: new URL(getBaseUrl()),
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
