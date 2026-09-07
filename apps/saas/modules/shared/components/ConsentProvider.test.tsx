import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	consent: {
		allowCookies: vi.fn(),
		consentStatus: "undecided" as "accepted" | "declined" | "undecided",
		declineCookies: vi.fn(),
		userHasConsented: false,
	},
}));

vi.mock("@shared/hooks/cookie-consent", () => ({
	useCookieConsent: () => mocks.consent,
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
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
		mocks.consent.consentStatus = "undecided";
		mocks.consent.userHasConsented = false;
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
		expect(undecidedMarkup).toContain(">message<");
		expect(undecidedMarkup).toContain(">decline<");
		expect(undecidedMarkup).toContain(">allow<");

		mocks.consent.consentStatus = "declined";
		expect(renderToStaticMarkup(<ConsentBanner />)).toBe("");

		mocks.consent.consentStatus = "accepted";
		mocks.consent.userHasConsented = true;
		expect(renderToStaticMarkup(<ConsentBanner />)).toBe("");
	});
});
