import { readFileSync } from "node:fs";

import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useGuestTrial: vi.fn() }));

vi.mock("../../hooks/use-guest-trial", () => ({ useGuestTrial: mocks.useGuestTrial }));

import { GuestTrialWorkspace } from "./GuestTrialWorkspace";

const expectations = {
	en: {
		source: "Ready for this edit",
		placeholder: "Your image will appear here",
		compact: "Watermarked · temporary",
		count: "1,234 / 10,000",
		bonus: "receive 8 credits once for two MiniMax H3 Image 1K generations, with no monthly refill",
	},
	de: {
		source: "Bereit für diese Bearbeitung",
		placeholder: "Dein Bild erscheint hier",
		compact: "Mit Wasserzeichen · temporär",
		count: "1.234 / 10.000",
		bonus:
			"einmalig 8 Credits für zwei Generierungen mit MiniMax H3 Image 1K, ohne monatliche Auffüllung",
	},
	es: {
		source: "Lista para esta edición",
		placeholder: "Tu imagen aparecerá aquí",
		compact: "Con marca de agua · temporal",
		count: "1234 / 10.000",
		bonus:
			"8 créditos una sola vez para dos generaciones con MiniMax H3 Image 1K, sin recarga mensual",
	},
	fr: {
		source: "Prête pour cette retouche",
		placeholder: "Votre image apparaîtra ici",
		compact: "Filigrané · temporaire",
		count: "1 234 / 10 000",
		bonus:
			"8 crédits une seule fois pour deux générations MiniMax H3 Image 1K, sans renouvellement mensuel",
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
				setModel: vi.fn(),
				canSubmit: true,
				isSubmitting: false,
				resultUrl: null,
				trialAllowance: { remaining: 0, limit: 1 },
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
			expect(markup).toContain("<details");
			expect(markup).not.toContain("<details open");
			expect(visibleText).toContain(expected.count);
			expect(visibleText).toContain(expected.bonus);
		},
	);
});

function normalizeSpaces(value: string): string {
	return value.replaceAll(/[\s\u00a0\u202f]+/g, " ");
}
