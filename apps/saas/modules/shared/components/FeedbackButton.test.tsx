import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import en from "../../../../../packages/i18n/translations/en/shared.json";

const state = vi.hoisted(() => ({ dialogImported: vi.fn() }));

vi.mock("./FeedbackDialog", async (importOriginal) => {
	state.dialogImported();
	return importOriginal();
});

import { FeedbackButton } from "./FeedbackButton";

it("renders an accessible gift entry without loading its dialog before interaction", () => {
	const markup = renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<FeedbackButton supportEmail="help@configured.test" />
		</NextIntlClientProvider>,
	);
	expect(markup).toContain(en.feedback.entry);
	expect(markup).toContain('aria-haspopup="dialog"');
	expect(markup).toContain('aria-expanded="false"');
	expect(markup).not.toContain(en.feedback.title);
	expect(state.dialogImported).not.toHaveBeenCalled();
});
