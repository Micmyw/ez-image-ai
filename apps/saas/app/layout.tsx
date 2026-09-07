import { config } from "@config";
import { cn, Toaster } from "@repo/ui";
import { ApiClientProvider } from "@shared/components/ApiClientProvider";
import { ClientProviders } from "@shared/components/ClientProviders";
import { ConsentBanner } from "@shared/components/ConsentBanner";
import { ConsentProvider } from "@shared/components/ConsentProvider";
import { getBaseUrl, parseGoogleSiteVerification } from "@shared/lib/base-url";
import { parseConsentStatus } from "@shared/lib/consent";
import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { ThemeProvider } from "next-themes";
import { Plus_Jakarta_Sans } from "next/font/google";
import { cookies } from "next/headers";

import "./globals.css";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { PropsWithChildren } from "react";

const sansFont = Plus_Jakarta_Sans({
	weight: ["300", "400", "500", "600", "700"],
	subsets: ["latin"],
	variable: "--font-sans",
});

export const metadata: Metadata = {
	applicationName: config.appName,
	description: config.appDescription,
	metadataBase: new URL(getBaseUrl()),
	robots: {
		index: false,
		follow: false,
	},
	...(parseGoogleSiteVerification(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION)
		? {
				verification: {
					google: parseGoogleSiteVerification(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION),
				},
			}
		: {}),
	title: {
		absolute: config.appName,
		default: config.appName,
		template: `%s | ${config.appName}`,
	},
};

export default async function RootLayout({ children }: PropsWithChildren) {
	const locale = await getLocale();
	const messages = await getMessages();
	const consentStatus = parseConsentStatus((await cookies()).get("consent")?.value);

	return (
		<html lang={locale} suppressHydrationWarning className={sansFont.variable}>
			<body className={cn("min-h-screen bg-background text-foreground antialiased")}>
				<ConsentProvider initialConsentStatus={consentStatus}>
					<NuqsAdapter>
						<NextIntlClientProvider messages={messages}>
							<ThemeProvider
								attribute="class"
								disableTransitionOnChange
								enableSystem
								defaultTheme={config.defaultTheme}
								themes={Array.from(config.enabledThemes)}
							>
								<ApiClientProvider>
									<ClientProviders>
										{children}

										<ConsentBanner />
										<Toaster position="top-right" />
									</ClientProviders>
								</ApiClientProvider>
							</ThemeProvider>
						</NextIntlClientProvider>
					</NuqsAdapter>
				</ConsentProvider>
			</body>
		</html>
	);
}
