import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import de from "../../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../../packages/i18n/translations/en/saas.json";
import es from "../../../../../packages/i18n/translations/es/saas.json";
import fr from "../../../../../packages/i18n/translations/fr/saas.json";

vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: null, loaded: true }) }));
vi.mock("../lib/api", () => ({ videoEffectsApi: {} }));
vi.mock("../lib/analytics", () => ({ recordVideoEffectEvent: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));
vi.mock("../../video-v1/use-video", () => ({ usePageVisible: () => true }));
import { DuoPhotoInputs } from "./DuoPhotoInputs";
import { VideoEffectGenerator } from "./VideoEffectGenerator";

function leaves(value: object, prefix = ""): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, child]) =>
			typeof child === "string"
				? [[`${prefix}${key}`, [...child.matchAll(/\{(\w+)/g)].map((match) => match[1]).sort()]]
				: Object.entries(leaves(child, `${prefix}${key}.`)),
		),
	);
}
describe("Hotel Lobby public UI", () => {
	it.each([
		{ locale: "en", messages: en },
		{ locale: "de", messages: de },
	])(
		"renders login before upload and truthful unavailable samples in $locale",
		({ locale, messages }) => {
			const errors = vi.fn();
			const html = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					messages={{ videoEffects: messages.videoEffects }}
					timeZone="UTC"
					onError={errors}
				>
					<VideoEffectGenerator initialJobId={null} />
				</NextIntlClientProvider>,
			);
			expect(html).toContain("/login?redirectTo=%2Fvideo-effects%2Fhotel-lobby-ai");
			expect(html).toContain(messages.videoEffects.samplesPending);
			expect(html).toContain(messages.videoEffects.betaHint);
			expect(html).not.toMatch(
				/<video|<textarea|<select|seedance|nano-banana|kie|fixed_lens|scenePrompt|providerModel/i,
			);
			expect(html.match(/type="file"/g)).toHaveLength(2);
			expect(html.match(/fieldset[^>]*disabled/g)).toHaveLength(2);
			expect(errors).not.toHaveBeenCalled();
		},
	);
	it("renders real left and right sealed identities without exposing asset IDs", () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<DuoPhotoInputs
					slots={{
						left: { assetId: "private-left", preview: null, status: "sealed" },
						right: { assetId: "private-right", preview: null, status: "sealed" },
					}}
					maxBytes={10_000_000}
					disabled={false}
					onSelect={vi.fn()}
					onClear={vi.fn()}
					onSwap={vi.fn()}
				/>
			</NextIntlClientProvider>,
		);
		expect(html).toContain(en.videoEffects.left);
		expect(html).toContain(en.videoEffects.right);
		expect(html).not.toContain("private-left");
		expect(html).not.toContain("private-right");
		expect(html).toContain("10,000,000");
	});
	it("retains the validated original task through login without photo or storage credentials", () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<VideoEffectGenerator initialJobId="existing-private-job" />
			</NextIntlClientProvider>,
		);
		expect(html).toContain(
			"redirectTo=%2Fvideo-effects%2Fhotel-lobby-ai%3Fjob%3Dexisting-private-job",
		);
	});
	it.each([de, es, fr])("preserves every locale leaf and interpolation contract", (messages) => {
		expect(leaves(messages.videoEffects)).toEqual(leaves(en.videoEffects));
	});
});
