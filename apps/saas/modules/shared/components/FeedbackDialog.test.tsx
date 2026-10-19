import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import de from "../../../../../packages/i18n/translations/de/shared.json";
import en from "../../../../../packages/i18n/translations/en/shared.json";
import es from "../../../../../packages/i18n/translations/es/shared.json";
import fr from "../../../../../packages/i18n/translations/fr/shared.json";

vi.mock("@repo/ui/components/dialog", () => ({
	Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
		open ? <div>{children}</div> : null,
	DialogContent: ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
	DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
	DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
	DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

import { FeedbackButton } from "./FeedbackButton";
import { FeedbackDialog } from "./FeedbackDialog";

const locales = { en, de, es, fr };

describe("customer feedback", () => {
	it.each(Object.entries(locales))(
		"renders a user-controlled email draft in %s",
		(locale, messages) => {
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages}>
					<FeedbackDialog
						open
						onOpenChange={() => {}}
						supportEmail="help@configured.test"
						initialKind="bug"
					/>
				</NextIntlClientProvider>,
			);
			expect(markup).toContain(messages.feedback.title);
			expect(markup).toContain(messages.feedback.rewardPolicy);
			expect(markup).toContain(messages.feedback.privacy);
			expect(markup).toContain(messages.feedback.screenshots);
			expect(markup).toContain("help@configured.test");
			expect(markup).toContain('type="email"');
			expect(markup).toContain("<textarea");
			expect(markup).not.toContain('type="file"');
			expect(markup).not.toContain('type="hidden"');
			const href = markup.match(/href="(mailto:[^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
			const draft = new URL(href!);
			expect(draft.pathname).toBe("help@configured.test");
			expect(draft.searchParams.get("subject")).toBe(messages.feedback.subjectBug);
			expect([...draft.searchParams.keys()]).toEqual(["subject", "body"]);
		},
	);
	it("keeps the gift entry accessible and static before interaction", () => {
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en}>
				<FeedbackButton supportEmail="help@configured.test" />
			</NextIntlClientProvider>,
		);
		expect(markup).toContain(en.feedback.entry);
		expect(markup).toContain('type="button"');
		expect(markup).toContain('aria-haspopup="dialog"');
		expect(markup).toContain('aria-expanded="false"');
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain("feedback-trigger");
		expect(markup).not.toContain("feedback-burst");
		expect(markup).not.toContain("<dialog");
	});
	it("does not invent a destination when support is not configured", () => {
		expect(
			renderToStaticMarkup(
				<NextIntlClientProvider locale="en" messages={en}>
					<FeedbackButton />
				</NextIntlClientProvider>,
			),
		).toBe("");
	});
});
