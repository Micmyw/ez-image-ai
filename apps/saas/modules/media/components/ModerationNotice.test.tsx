import { NextIntlClientProvider } from "next-intl";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import german from "../../../../../packages/i18n/translations/de/saas.json";
import english from "../../../../../packages/i18n/translations/en/saas.json";
import { ModerationNotice } from "./ModerationNotice";

const job = {
	id: "job-support-reference",
	status: "FAILED",
	failureReason: "CONTENT_NOT_ALLOWED",
	creditsCharged: "17",
};

function render(overrides: Record<string, unknown>, locale = "en") {
	return renderToStaticMarkup(
		<NextIntlClientProvider
			locale={locale}
			timeZone="UTC"
			messages={locale === "de" ? german : english}
		>
			<ModerationNotice job={{ ...job, ...overrides }} />
		</NextIntlClientProvider>,
	);
}

describe("customer moderation feedback", () => {
	it("separates the outcome, charge, next step and appeal without exposing detector data", () => {
		const markup = render({ moderationBilling: "CHARGED", moderationReason: "sexualContent" });
		expect(markup).toContain("This result cannot be shown");
		expect(markup).toContain("sexually explicit content");
		expect(markup).toContain("17 credits were charged");
		expect(markup).toContain("Edit the instruction or choose a different reference image");
		expect(markup).toContain('href="/terms"');
		expect(markup).toContain('href="/contact#report-content"');
		expect(markup).toContain("job-support-reference");
		expect(markup).not.toMatch(/waffo|seeapi|NSFW|CONTENT_NOT_ALLOWED|No credits were charged/i);
	});
	it("explains the one-time waiver and subsequent charges", () => {
		const markup = render({ creditsCharged: "0", moderationBilling: "WAIVED" });
		expect(markup).toContain("No credits were charged");
		expect(markup).toContain("one-time waiver was used");
		expect(markup).toContain("Future blocked results use the quoted credits");
	});
	it("never turns an unavailable review into a violation or prompts another paid attempt", () => {
		const markup = render({
			creditsCharged: "0",
			failureReason: "SAFETY_CHECK_UNAVAILABLE",
			moderationReason: "sexualContent",
		});
		expect(markup).toContain("Safety review unavailable");
		expect(markup).toContain("not a confirmed content violation");
		expect(markup).toContain("one-time waiver was not used");
		expect(markup).toContain("Try again later");
		expect(markup).not.toContain("sexually explicit content");
		expect(markup).not.toContain("charged for this generation");
	});
	it("uses a generic explanation for unknown labels and ledger-only billing for legacy jobs", () => {
		const markup = render({ moderationReason: "raw-private-label", creditsCharged: "0" });
		expect(markup).toContain("more specific reason is not available");
		expect(markup).not.toMatch(/raw-private-label|waiver was used/);
	});
	it("renders translated reasons and interpolated charges in German", () => {
		const markup = render(
			{ moderationBilling: "CHARGED", moderationReason: "sexualContent" },
			"de",
		);
		expect(markup).toContain("17 Credits");
		expect(markup).not.toContain("This result cannot be shown");
		expect(markup).not.toContain("{credits}");
	});
});
