import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pathname: "/" as string | null,
	consent: {
		allowCookies: vi.fn(),
		consentStatus: "undecided" as "accepted" | "declined" | "undecided",
		declineCookies: vi.fn(),
		userHasConsented: false,
		showBanner: true,
		preferencesOpen: false,
		privacySignal: false,
		closePreferences: vi.fn(),
	},
}));

vi.mock("@shared/hooks/cookie-consent", () => ({
	useCookieConsent: () => mocks.consent,
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
	usePathname: () => mocks.pathname,
}));

vi.mock("@repo/ui/components/button", () => ({
	Button: ({ children, ...props }: { children: ReactNode }) => (
		<button {...props}>{children}</button>
	),
}));

import { ConsentBanner } from "./ConsentBanner";
import { ConsentContext, ConsentProvider } from "./ConsentProvider";

describe("consent state", () => {
	beforeEach(() => {
		mocks.pathname = "/";
		mocks.consent.consentStatus = "undecided";
		mocks.consent.userHasConsented = false;
		mocks.consent.showBanner = true;
		mocks.consent.preferencesOpen = false;
		mocks.consent.privacySignal = false;
	});

	it("preserves a declined server cookie instead of treating it as undecided", () => {
		const markup = renderToStaticMarkup(
			<ConsentProvider initialConsentStatus="declined">
				<ConsentContext.Consumer>
					{(value) => <span>{value.consentStatus}</span>}
				</ConsentContext.Consumer>
			</ConsentProvider>,
		);

		expect(markup).toContain(">declined<");
	});

	it("renders choices only while consent is undecided", () => {
		mocks.consent.consentStatus = "undecided";
		const undecidedMarkup = renderToStaticMarkup(<ConsentBanner />);
		expect(undecidedMarkup).toContain("message");
		expect(undecidedMarkup).toContain(">decline<");
		expect(undecidedMarkup).toContain(">allow<");

		mocks.consent.consentStatus = "declined";
		mocks.consent.showBanner = false;
		expect(renderToStaticMarkup(<ConsentBanner />)).toBe("");

		mocks.consent.consentStatus = "accepted";
		mocks.consent.userHasConsented = true;
		expect(renderToStaticMarkup(<ConsentBanner />)).toBe("");
	});

	it.each(["/", "/create", "/pricing", "/blog/raindance", "/docs/privacy"])(
		"preserves automatic consent notices on public pages: %s",
		(pathname) => {
			mocks.pathname = pathname;
			expect(renderToStaticMarkup(<ConsentBanner />)).toContain("data-consent-banner");
		},
	);

	it.each([
		"/history",
		"/history/private-job",
		"/video/history",
		"/assets",
		"/edits",
		"/settings/billing",
		"/settings/general",
		"/admin",
		"/admin/analytics",
		"/my-team/settings/billing",
		null,
	])("keeps automatic notices off private pages: %s", (pathname) => {
		mocks.pathname = pathname;
		expect(renderToStaticMarkup(<ConsentBanner />)).toBe("");
	});

	it.each(["/history", "/settings/billing", "/admin"])(
		"allows explicitly reopened privacy settings on private pages: %s",
		(pathname) => {
			mocks.pathname = pathname;
			mocks.consent.consentStatus = "declined";
			mocks.consent.preferencesOpen = true;
			expect(renderToStaticMarkup(<ConsentBanner />)).toContain(">decline<");
		},
	);

	it("respects browser privacy signals when settings are reopened on a private page", () => {
		mocks.pathname = "/history";
		mocks.consent.preferencesOpen = true;
		mocks.consent.privacySignal = true;
		const markup = renderToStaticMarkup(<ConsentBanner />);
		expect(markup).toContain("privacySignal");
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>allow<\/button>/);
	});

	it("updates automatic visibility across public and private navigation without recording a choice", () => {
		expect(renderToStaticMarkup(<ConsentBanner />)).toContain("data-consent-banner");
		mocks.pathname = "/history";
		expect(renderToStaticMarkup(<ConsentBanner />)).toBe("");
		mocks.pathname = "/pricing";
		expect(renderToStaticMarkup(<ConsentBanner />)).toContain("data-consent-banner");
		expect(mocks.consent.consentStatus).toBe("undecided");
	});
});
