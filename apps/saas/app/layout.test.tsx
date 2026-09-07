import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	consentCookie: undefined as string | undefined,
}));

const passthrough = ({ children }: { children: ReactNode }) => children;

vi.mock("@config", () => ({
	config: {
		appDescription: "Private image editing",
		appName: "EzPic",
		defaultTheme: "dark",
		enabledThemes: ["light", "dark"],
	},
}));
vi.mock("@repo/ui", () => ({ cn: (...values: string[]) => values.join(" "), Toaster: () => null }));
vi.mock("@shared/components/ApiClientProvider", () => ({ ApiClientProvider: passthrough }));
vi.mock("@shared/components/ClientProviders", () => ({ ClientProviders: passthrough }));
vi.mock("@shared/components/ConsentBanner", () => ({
	ConsentBanner: () => <aside data-test="consent-banner" />,
}));
vi.mock("@shared/components/ConsentProvider", () => ({
	ConsentProvider: ({
		children,
		initialConsentStatus,
	}: {
		children: ReactNode;
		initialConsentStatus: string;
	}) => <div data-initial-consent={initialConsentStatus}>{children}</div>,
}));
vi.mock("@shared/lib/base-url", () => ({
	getBaseUrl: () => "https://www.ezpic.test",
	parseGoogleSiteVerification: (value: string | undefined) => value,
}));
vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) =>
			name === "consent" && mocks.consentCookie ? { value: mocks.consentCookie } : undefined,
	}),
}));
vi.mock("next-intl", () => ({ NextIntlClientProvider: passthrough }));
vi.mock("next-intl/server", () => ({
	getLocale: async () => "en",
	getMessages: async () => ({}),
}));
vi.mock("next-themes", () => ({ ThemeProvider: passthrough }));
vi.mock("next/font/google", () => ({ Plus_Jakarta_Sans: () => ({ variable: "font-sans" }) }));
vi.mock("nuqs/adapters/next/app", () => ({ NuqsAdapter: passthrough }));

describe("SaaS root layout", () => {
	beforeEach(() => {
		mocks.consentCookie = undefined;
		vi.stubEnv(
			"NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION",
			"0123456789abcdefghijklmnopqrstuvwxyz_ABCD-EFGH",
		);
	});

	it.each([
		[undefined, "undecided"],
		["true", "accepted"],
		["false", "declined"],
		["unexpected", "undecided"],
	] as const)(
		"initializes consent %s as %s and mounts the consent UI",
		async (cookie, expected) => {
			mocks.consentCookie = cookie;
			const { default: RootLayout } = await import("./layout");
			const markup = renderToStaticMarkup(await RootLayout({ children: <main>content</main> }));

			expect(markup).toContain(`data-initial-consent="${expected}"`);
			expect(markup).toContain('data-test="consent-banner"');
		},
	);

	it("publishes the configured Google verification token in root metadata", async () => {
		const { metadata } = await import("./layout");
		expect(metadata.verification?.google).toBe(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION);
	});
});
