import { getUnifiedMessagesForLocale } from "@repo/i18n";
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
	DialogContent: ({ children, closeLabel }: { children: ReactNode; closeLabel: string }) => (
		<dialog open>
			<button aria-label={closeLabel} />
			{children}
		</dialog>
	),
	DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
	DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
	DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

import { FeedbackButton } from "./FeedbackButton";
import { FeedbackDialog, loadFeedbackMessages } from "./FeedbackDialog";

const locales = { en, de, es, fr };

describe("customer feedback", () => {
	it.each(Object.entries(locales))(
		"keeps a localized loading dialog with a close control before %s copy arrives",
		async (locale, messages) => {
			const full = await getUnifiedMessagesForLocale(locale as keyof typeof locales);
			const onError = vi.fn();
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					timeZone="UTC"
					onError={onError}
					messages={{ studio: full.studio, feedback: { entry: messages.feedback.entry } }}
				>
					<FeedbackDialog open onOpenChange={vi.fn()} supportEmail="help@configured.test" />
				</NextIntlClientProvider>,
			);
			expect(markup).toContain(full.studio.loading);
			expect(markup).toContain(`aria-label="${full.studio.closePanel}"`);
			expect(markup).not.toContain("mailto:");
			expect(onError).not.toHaveBeenCalled();
		},
	);
	it.each(Object.entries(locales))(
		"renders a user-controlled email draft in %s",
		async (locale, messages) => {
			const projected = await loadFeedbackMessages(locale);
			expect(projected).toEqual(messages.feedback);
			const onError = vi.fn();
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					timeZone="UTC"
					onError={onError}
					messages={{
						feedback: {
							entry: messages.feedback.entry,
							footer: messages.feedback.footer,
							report: messages.feedback.report,
						},
					}}
				>
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
			for (const key of [
				"kind",
				"idea",
				"bug",
				"accountEmail",
				"description",
				"preview",
				"openEmail",
				"copy",
				"emailFallback",
				"noAutomaticReward",
			] as const)
				expect(markup).toContain(messages.feedback[key]);
			expect(markup).toContain(`aria-label="${messages.feedback.close}"`);
			expect(onError).not.toHaveBeenCalled();
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
	it.each(Object.entries(locales))(
		"renders every public trigger from only three %s messages",
		(locale, messages) => {
			const onError = vi.fn();
			const feedback = {
				entry: messages.feedback.entry,
				footer: messages.feedback.footer,
				report: messages.feedback.report,
			};
			for (const variant of ["inline", "footer", "report"] as const) {
				const markup = renderToStaticMarkup(
					<NextIntlClientProvider
						locale={locale}
						timeZone="UTC"
						onError={onError}
						messages={{ feedback }}
					>
						<FeedbackButton supportEmail="help@configured.test" variant={variant} />
					</NextIntlClientProvider>,
				);
				expect(markup).toContain(feedback[variant === "inline" ? "entry" : variant]);
				expect(markup).not.toContain("<dialog");
			}
			expect(onError).not.toHaveBeenCalled();
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
