import { readFileSync } from "node:fs";

import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useGuestTrial: vi.fn() }));

vi.mock("../../hooks/use-guest-trial", () => ({ useGuestTrial: mocks.useGuestTrial }));

import { GuestTrialWorkspace } from "./GuestTrialWorkspace";

const expectations = {
	en: {
		source: "Transferred privately for this edit",
		placeholder: "Your watermarked result will appear here.",
		compact: "Watermarked · temporary",
		count: "1,234 / 10,000",
		bonus: "one-time 5-credit bonus",
	},
	de: {
		source: "Privat für diese Bearbeitung übergeben",
		placeholder: "Dein Ergebnis mit Wasserzeichen erscheint hier.",
		compact: "Mit Wasserzeichen · temporär",
		count: "1.234 / 10.000",
		bonus: "einmalig 5 Bonus-Credits",
	},
	es: {
		source: "Transferido de forma privada para esta edición",
		placeholder: "Tu resultado con marca de agua aparecerá aquí.",
		compact: "Con marca de agua · temporal",
		count: "1234 / 10.000",
		bonus: "bono único de 5 créditos",
	},
	fr: {
		source: "Transférée en privé pour cette retouche",
		placeholder: "Votre résultat filigrané apparaîtra ici.",
		compact: "Filigrané · temporaire",
		count: "1 234 / 10 000",
		bonus: "bonus unique de 5 crédits",
	},
} as const;

describe("GuestTrialWorkspace locales", () => {
	it.each(Object.entries(expectations))(
		"resolves the selected %s SaaS locale including both character-count values",
		(locale, expected) => {
			mocks.useGuestTrial.mockReturnValue({
				view: { state: "preparingSession" },
				draft: { sourceAssetId: "source-1", prompt: "x".repeat(1234) },
				prompt: "x".repeat(1234),
				setPrompt: vi.fn(),
				canSubmit: true,
				isSubmitting: false,
				resultUrl: null,
				dailyAllowance: { remaining: 0, limit: 2 },
				actions: {
					submit: vi.fn(),
					viewStatus: vi.fn(),
					viewResult: vi.fn(),
					download: vi.fn(),
					beginLink: vi.fn(),
				},
			});
			const messages = JSON.parse(
				readFileSync(
					new URL(
						`../../../../../../packages/i18n/translations/${locale}/saas.json`,
						import.meta.url,
					),
					"utf8",
				),
			) as Record<string, unknown>;

			const markup = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
					<GuestTrialWorkspace />
				</NextIntlClientProvider>,
			);
			const visibleText = normalizeSpaces(markup.replaceAll(/<[^>]+>/g, " "));

			expect(visibleText).toContain(expected.source);
			expect(visibleText).toContain(expected.placeholder);
			expect(visibleText).toContain(expected.compact);
			expect(visibleText).toContain(expected.count);
			expect(visibleText).toContain(expected.bonus);
		},
	);
});

function normalizeSpaces(value: string): string {
	return value.replaceAll(/[\s\u00a0\u202f]+/g, " ");
}
