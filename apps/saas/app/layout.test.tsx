import { getUnifiedMessagesForLocale } from "@repo/i18n";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	consentCookie: undefined as string | undefined,
	clientMessages: vi.fn(),
	locale: "en",
	serverMessages: undefined as Record<string, unknown> | undefined,
}));

const passthrough = ({ children }: { children: ReactNode }) => children;

vi.mock("@config", () => ({
	config: {
		appDescription: "Private image editing",
		appName: "EzImageAI",
		defaultTheme: "dark",
		enabledThemes: ["light", "dark"],
	},
}));
vi.mock("@repo/ui/lib", () => ({ cn: (...values: string[]) => values.join(" ") }));
vi.mock("@repo/ui/components/toast", () => ({ Toaster: () => null }));
vi.mock("@shared/components/ApiClientProvider", () => ({ ApiClientProvider: passthrough }));
vi.mock("@shared/components/ClientProviders", () => ({ ClientProviders: passthrough }));
vi.mock("@shared/components/SiteAnalytics", () => ({ SiteAnalytics: () => null }));
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
vi.mock("next-intl", () => ({
	NextIntlClientProvider: ({ children, messages }: { children: ReactNode; messages: unknown }) => {
		mocks.clientMessages(messages);
		return children;
	},
}));
vi.mock("next-intl/server", () => ({
	getLocale: async () => mocks.locale,
	getMessages: async () =>
		mocks.serverMessages ?? {
			common: { menu: { login: "Sign In" } },
			home: { title: "Image editor" },
			admin: { title: "Administration" },
			faq: { items: { question: "Frequently asked question" } },
			publicContent: { contact: { description: "Contact support" } },
			videoV1: { title: "Create a short video" },
			videoEffects: {
				name: "Hotel Lobby AI",
				navigationDescription: "Create a video with two photos",
				left: "Left photo",
			},
		},
}));
vi.mock("next-themes", () => ({ ThemeProvider: passthrough }));
vi.mock("next/font/google", () => ({ Plus_Jakarta_Sans: () => ({ variable: "font-sans" }) }));
vi.mock("nuqs/adapters/next/app", () => ({ NuqsAdapter: passthrough }));

describe("SaaS root layout", () => {
	beforeEach(() => {
		mocks.consentCookie = undefined;
		mocks.clientMessages.mockClear();
		mocks.locale = "en";
		mocks.serverMessages = undefined;
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
			expect(markup).not.toContain("data-clarity-mask");
		},
	);

	it("publishes the configured Google verification token in root metadata", async () => {
		const { metadata } = await import("./layout");
		expect(metadata.verification?.google).toBe(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION);
	});

	it("keeps administration, video and server-only copy out of the shared client payload", async () => {
		const { default: RootLayout } = await import("./layout");
		renderToStaticMarkup(await RootLayout({ children: <main>content</main> }));

		expect(mocks.clientMessages).toHaveBeenCalledWith({
			common: { menu: { login: "Sign In" } },
			home: { title: "Image editor" },
			videoEffects: {
				name: "Hotel Lobby AI",
				navigationDescription: "Create a video with two photos",
			},
		});
	});

	it.each(["en", "de", "es", "fr"] as const)(
		"retains %s server-rendered FAQ and contact copy while preserving interactive translations",
		async (locale) => {
			const fullMessages = await getUnifiedMessagesForLocale(locale);
			mocks.locale = locale;
			mocks.serverMessages = fullMessages;
			const { default: RootLayout } = await import("./layout");
			const serverContent = (
				<main>
					<h2>{fullMessages.faq.items.restrictions.question}</h2>
					<p>{fullMessages.faq.items.restrictions.answer}</p>
					<a href="/contact#report-content">
						{fullMessages.publicContent.contact.reporting.footerLabel}
					</a>
				</main>
			);
			const markup = renderToStaticMarkup(await RootLayout({ children: serverContent }));

			expect(markup).toContain(`lang="${locale}"`);
			expect(markup).toContain(renderToStaticMarkup(serverContent));
			const [clientMessages] = mocks.clientMessages.mock.lastCall ?? [];
			expect(clientMessages).not.toHaveProperty("admin");
			expect(clientMessages).not.toHaveProperty("faq");
			expect(clientMessages).not.toHaveProperty("publicContent");
			expect(clientMessages).not.toHaveProperty("videoV1");
			expect(clientMessages.videoEffects).toEqual({
				name: fullMessages.videoEffects.name,
				navigationDescription: fullMessages.videoEffects.navigationDescription,
			});
			for (const [namespace, messages] of Object.entries(fullMessages)) {
				if (!["admin", "faq", "publicContent", "videoV1", "videoEffects"].includes(namespace)) {
					expect(clientMessages[namespace]).toEqual(messages);
				}
			}
			expect(fullMessages.faq.items.restrictions.answer).not.toBe("");
			expect(fullMessages.publicContent.contact.reporting.footerLabel).not.toBe("");
		},
	);
});
