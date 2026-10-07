import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import de from "../../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../../packages/i18n/translations/en/saas.json";

const mocks = vi.hoisted(() => ({
	user: { id: "tester", isAnonymous: false } as { id: string; isAnonymous: boolean } | null,
	access: vi.fn(),
	query: vi.fn(),
}));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: mocks.user }) }));
vi.mock("@payments/components/upgrade-context", () => ({ useUpgrade: () => undefined }));
vi.mock("@tanstack/react-query", () => ({
	useQuery: mocks.query,
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../lib/api", () => ({ videoEffectsApi: { access: mocks.access } }));
vi.mock("../lib/analytics", () => ({ recordVideoEffectEvent: vi.fn() }));
vi.mock("../../video-v1/use-video", () => ({ usePageVisible: () => true }));
vi.mock("./VideoEffectHistory", () => ({
	VideoEffectHistory: () => <section id="rumpelstiltskin-history" />,
}));
vi.mock("./VideoEffectJob", () => ({
	VideoEffectJob: ({ jobId }: { jobId: string }) => <section data-owned-job={jobId} />,
}));

import { RumpelstiltskinWorkbench } from "./RumpelstiltskinWorkbench";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.user = { id: "tester", isAnonymous: false };
	mocks.query.mockReturnValue({
		isPending: false,
		data: {
			effectId: "rumpelstiltskin-solo",
			available: false,
			accessAllowed: true,
			reasons: ["MOTION_REFERENCE_REQUIRED", "COST_APPROVAL_REQUIRED"],
			maxInputBytes: 10_000_000,
			credits: null,
			creditBalance: null,
		},
	});
});

describe("Rumpelstiltskin account workbench", () => {
	it("renders only existing task and history when generation admission has closed", () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<RumpelstiltskinWorkbench initialJobId="owned-test" readOnly />
			</NextIntlClientProvider>,
		);
		expect(html).toContain('data-owned-job="owned-test"');
		expect(html).toContain('id="rumpelstiltskin-history"');
		expect(html).not.toContain('type="file"');
		expect(html).not.toContain(en.videoEffects.getQuote);
		expect(html).not.toContain(en.videoEffects.addCredits);
		expect(mocks.query).not.toHaveBeenCalled();
	});
	it.each([
		{ locale: "en", messages: en },
		{ locale: "de", messages: de },
	])(
		"renders one disabled photo and explicit readiness blockers in $locale without sales or fake samples",
		({ locale, messages }) => {
			const errors = vi.fn();
			const html = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC" onError={errors}>
					<RumpelstiltskinWorkbench initialJobId={null} />
				</NextIntlClientProvider>,
			);
			expect(html.match(/type="file"/g)).toHaveLength(1);
			expect(html.match(/fieldset[^>]*disabled/g)).toHaveLength(1);
			expect(html).toContain(messages.videoEffects.rumpelstiltskin.motionRequired);
			expect(html).toContain(messages.videoEffects.rumpelstiltskin.costRequired);
			expect(html).toContain(messages.videoEffects.rumpelstiltskin.testHint);
			expect(html).not.toContain(messages.videoEffects.addCredits);
			expect(html).not.toContain(messages.videoEffects.swap);
			expect(html).not.toMatch(/<video|<img|type="url"|69 credits|seedance|kie|providerModel/i);
			expect(html).not.toMatch(/internal test|solo test|Interner Test|Solotest/i);
			expect(errors).not.toHaveBeenCalled();
		},
	);
	it("queries the effect independently from the other paid templates", async () => {
		renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<RumpelstiltskinWorkbench initialJobId={null} />
			</NextIntlClientProvider>,
		);
		const options = mocks.query.mock.calls[0][0];
		expect(options.queryKey).toEqual(["video-effects", "access", "tester", "rumpelstiltskin-solo"]);
		await options.queryFn();
		expect(mocks.access).toHaveBeenCalledWith({ effectId: "rumpelstiltskin-solo" });
	});
	it("preserves only a task identifier in the login return URL", () => {
		mocks.user = null;
		const html = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<RumpelstiltskinWorkbench initialJobId="existing-test" />
			</NextIntlClientProvider>,
		);
		expect(html).toContain("redirectTo=%2Fvideo%2Feffects%2Frumpelstiltskin%3Fjob%3Dexisting-test");
		expect(mocks.query).not.toHaveBeenCalled();
	});
});
