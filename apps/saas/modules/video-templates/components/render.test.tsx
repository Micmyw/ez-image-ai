import {
	FLYING_CAR_TEMPLATE_KEYS,
	sourceTemplateDefaults,
} from "@repo/config/video-template-library";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import de from "../../../../../packages/i18n/translations/de/video.json";
import en from "../../../../../packages/i18n/translations/en/video.json";
import es from "../../../../../packages/i18n/translations/es/video.json";
import fr from "../../../../../packages/i18n/translations/fr/video.json";

vi.mock("../lib/api", () => ({ videoTemplatesApi: {} }));

import { TemplateInput } from "./TemplateInput";
import { TemplateOptions } from "./TemplateOptions";
import { TemplateRoleLabel } from "./TemplateSetup";

function render(children: ReactNode, messages = en, locale = "en") {
	const errors = vi.fn();
	const html = renderToStaticMarkup(
		<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC" onError={errors}>
			{children}
		</NextIntlClientProvider>,
	);
	expect(errors).not.toHaveBeenCalled();
	return html;
}

describe("original source template controls", () => {
	it.each([
		{ locale: "en", messages: en },
		{ locale: "de", messages: de },
		{ locale: "es", messages: es },
		{ locale: "fr", messages: fr },
	])("shows Hotel Lobby duration as template-defined in $locale", ({ locale, messages }) => {
		const html = render(
			<TemplateOptions
				templateKey="source-hotel-lobby"
				value={sourceTemplateDefaults("source-hotel-lobby")}
				onChange={vi.fn()}
			/>,
			messages,
			locale,
		);
		expect(html).toContain(messages.videoTemplates.templateDuration);
		expect(html).toContain('aria-labelledby="vt-duration-label"');
		expect(html).not.toContain('id="vt-duration"');
		expect(html).not.toMatch(/0 seconds|value="0"/);
	});
	it.each(FLYING_CAR_TEMPLATE_KEYS)(
		"offers only the original visible controls for %s",
		(templateKey) => {
			const html = render(
				<TemplateOptions
					templateKey={templateKey}
					value={sourceTemplateDefaults(templateKey)}
					onChange={vi.fn()}
				/>,
			);
			const seconds = templateKey.includes("curved-ramp") ? 15 : 7;
			expect(html).toContain(`${seconds} seconds`);
			expect(html).toContain('value="768P"');
			expect(html).toContain('value="2K"');
			expect(html).toContain("16:9</output>");
			expect(html.match(/<select/g)).toHaveLength(1);
			expect(html).not.toContain('id="vt-duration"');
			expect(html).not.toMatch(/id="vt-(mode|tier|stage|scene|direction)"|<textarea/);
		},
	);
	it("shows Green Booth's fixed format without fake choices and names the actual roles", () => {
		const html = render(
			<TemplateOptions
				templateKey="green-booth-freestyle"
				value={sourceTemplateDefaults("green-booth-freestyle")}
				onChange={vi.fn()}
			/>,
		);
		expect(html).not.toContain("<select");
		expect(html).toContain("10 seconds");
		expect(html).toContain("768P</output>");
		expect(html).toContain("16:9</output>");
		const firstRole = "performer-1";
		const secondRole = "performer-2";
		expect(
			render(<TemplateRoleLabel templateKey="green-booth-freestyle" role={firstRole} />),
		).toContain("Left · hype partner");
		expect(
			render(<TemplateRoleLabel templateKey="green-booth-freestyle" role={secondRole} />),
		).toContain("Right · lead rapper");
	});
	it.each([undefined, "private-object-image"])(
		"accepts a neutral subject image without portrait-only labels (%s)",
		(assetId) => {
			const inputRole = "subject";
			const html = render(
				<TemplateInput
					templateKey="flying-car-fleet-front"
					role={inputRole}
					assetId={assetId}
					maximumBytes={10_000_000}
					disabled={false}
					onChange={vi.fn()}
					onBusy={vi.fn()}
				/>,
			);
			expect(html).toContain(en.videoTemplates.roles.subject);
			expect(html).toContain(en.videoTemplates.chooseImage);
			expect(html).not.toMatch(/portrait|Choose photo|private-object-image/);
			expect(html.match(/type="file"/g)).toHaveLength(1);
			if (assetId) expect(html).toContain(en.videoTemplates.loadingPhoto);
		},
	);
});
