import { sourceTemplatePriceKey } from "@repo/config/video-template-display-pricing";
import { getVideoTemplate, sourceTemplateDefaults } from "@repo/config/video-template-library";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import de from "../../../../../packages/i18n/translations/de/video.json";
import en from "../../../../../packages/i18n/translations/en/video.json";
import es from "../../../../../packages/i18n/translations/es/video.json";
import fr from "../../../../../packages/i18n/translations/fr/video.json";

const fixture = vi.hoisted(() => ({ access: {} as Record<string, unknown> }));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: { id: "owner" } }) }));
vi.mock("@payments/components/upgrade-context", () => ({ useUpgrade: () => null }));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => fixture.access,
	useQueryClient: () => ({}),
}));
vi.mock("../lib/api", () => ({ videoTemplatesApi: {} }));
vi.mock("./TemplateInput", () => ({ TemplateInput: () => null }));
vi.mock("./TemplateJob", () => ({ TemplateJob: () => null, TemplateHistory: () => null }));
vi.mock("./TemplatePreview", () => ({
	TemplatePreview: () => null,
	TemplateSample: () => null,
	TemplatePreviewProvider: ({ children }: { children: ReactNode }) => children,
}));

import { TemplateWorkspace } from "./TemplateWorkspace";

const pricing = {
	version: 1,
	creditsByOptions: { [sourceTemplatePriceKey(sourceTemplateDefaults("kung-fu-cat"))]: "69" },
};
describe.each([
	{ locale: "en", messages: en },
	{ locale: "de", messages: de },
	{ locale: "es", messages: es },
	{ locale: "fr", messages: fr },
])("template price presentation in $locale", ({ locale, messages }) => {
	it.each(["priced-unavailable", "loading", "unpriced", "error"])(
		"renders a meaningful generation label for %s",
		(state) => {
			fixture.access = {
				isPending: state === "loading",
				isError: state === "error",
				data:
					state === "loading" || state === "error"
						? undefined
						: { available: false, pricing: state === "priced-unavailable" ? pricing : null },
			};
			const errors = vi.fn();
			const html = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC" onError={errors}>
					<TemplateWorkspace template={getVideoTemplate("kung-fu-cat")!} />
				</NextIntlClientProvider>,
			);
			const label =
				state === "priced-unavailable"
					? messages.videoTemplates.generate.replace("{credits}", "69")
					: state === "loading"
						? messages.videoTemplates.loadingPrice
						: messages.videoTemplates.priceUnavailable;
			expect(html).toContain(label);
			expect(html).toMatch(/<button[^>]*class="vt-primary"[^>]*disabled=""/);
			expect(html).not.toContain("… credits");
			expect(errors).not.toHaveBeenCalled();
		},
	);
});
