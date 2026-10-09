import { getVideoModelOptions } from "@repo/config/video-models";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import de from "../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../packages/i18n/translations/en/saas.json";
import es from "../../../../packages/i18n/translations/es/saas.json";
import fr from "../../../../packages/i18n/translations/fr/saas.json";
import type { VideoState } from "./api";
import { getVideoErrorKey, initialVideoDraft } from "./model";

vi.mock("./api", () => ({ videoApi: { jobs: { playback: vi.fn() } } }));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "owner-1", isAnonymous: false } }),
}));
vi.mock("./use-video", () => ({ usePageVisible: () => true, useVideoJob: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
	useInfiniteQuery: () => ({
		data: {
			pages: [
				{
					items: ["hotel-lobby-duo", "raindance-solo", "raindance-duo", null].map((effectId) => ({
						jobId: effectId ?? "ordinary",
						stage: "READY",
						creditState: "SETTLED",
						credits: "69",
						updatedAt: "2026-10-07T00:00:00Z",
						...(effectId
							? { effect: { effectId, name: effectId, templateVersion: "fixture" } }
							: {}),
					})),
				},
			],
		},
		isPending: false,
		isError: false,
		refetch: vi.fn(),
	}),
	useQuery: () => ({
		data: { url: "/api/video-v1/mock-private?expires=1", expiresAt: "2030-01-01T00:00:00Z" },
		isPending: false,
		isError: false,
		refetch: vi.fn(),
	}),
}));

import { VideoHistory } from "./VideoHistory";
import { VideoStateCard } from "./VideoJob";
import { VideoOutputDetails } from "./VideoOutputDetails";
import { VideoAnnualBadge, VideoAnnualBanner, VideoRetailPrice } from "./VideoRetailPrice";
import { VideoSettings } from "./VideoSettings";

function render(stage: VideoState["stage"], canPlay = false) {
	const state: VideoState = {
		jobId: "test-job",
		stage,
		canPlay,
		creditState: "RESERVED",
		credits: "23",
		failureCode: null,
		updatedAt: "2026-10-04T00:00:00Z",
	};
	return renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en}>
			<VideoStateCard state={state} />
		</NextIntlClientProvider>,
	);
}

describe("truthful video delivery UI", () => {
	it.each([
		{ locale: "en", messages: en },
		{ locale: "de", messages: de },
		{ locale: "es", messages: es },
		{ locale: "fr", messages: fr },
	])(
		"renders measured output and advisory warnings in $locale without replacing READY or playback",
		({ locale, messages }) => {
			const output = {
				schemaVersion: 1 as const,
				actual: { durationMillis: 5050, width: 496, height: 864, audioTracks: 1 },
				requested: { durationSeconds: 5, resolution: "720p", aspectRatio: "9:16", sound: false },
				warnings: ["UNEXPECTED_AUDIO", "RESOLUTION_MISMATCH"] as const,
			};
			const state: VideoState = {
				jobId: "quality-fixture",
				stage: "READY",
				canPlay: true,
				creditState: "SETTLED",
				credits: "23",
				failureCode: null,
				updatedAt: "2026-10-09T00:00:00Z",
				output: { ...output, warnings: [...output.warnings] },
			};
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages}>
					<VideoStateCard state={state} />
				</NextIntlClientProvider>,
			);
			expect(markup).toContain('data-stage="READY"');
			expect(markup).toContain("496 × 864 px");
			expect(markup).toContain("720p");
			expect(markup).toContain(messages.videoV1.output.warnings.UNEXPECTED_AUDIO);
			expect(markup).toContain(messages.videoV1.output.warnings.RESOLUTION_MISMATCH);
			expect(markup).toContain(messages.videoV1.output.original);
			expect(markup).toContain("<video");
			expect(markup).toContain(messages.videoV1.download);
			const clean = renderToStaticMarkup(
				<NextIntlClientProvider locale={locale} messages={messages}>
					<VideoOutputDetails output={{ ...output, warnings: [] }} />
				</NextIntlClientProvider>,
			);
			expect(clean).not.toContain('role="note"');
		},
	);
	it.each(["standard", "annual"] as const)(
		"renders the backend %s pair and rounded credit savings without a blanket half-price claim",
		(audience) => {
			const pricing = {
				policyVersion: "video-retail-2026-10-08.1",
				audience,
				credits: audience === "annual" ? "66" : "96",
				standardCredits: "96",
				annualCredits: "66",
				savedCredits: audience === "annual" ? "30" : "0",
				annualSavingsCredits: "30",
			};
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider locale="en" messages={en}>
					<VideoAnnualBanner pricing={pricing} />
					<VideoAnnualBadge pricing={pricing} />
					<VideoRetailPrice pricing={pricing} />
				</NextIntlClientProvider>,
			);
			expect(markup).toContain("96 credits");
			expect(markup).toContain("66 credits");
			expect(markup).toContain("30 credits (31.2%)");
			expect(markup).toContain("Annual −31.2%");
			expect(markup.includes("<s>")).toBe(audience === "annual");
			expect(markup).not.toMatch(/half.price|50%|5100|markup|subscriptionId/i);
		},
	);
	it("hides fake discount badges and strike-throughs when rounded prices are equal", () => {
		const pricing = {
			policyVersion: "video-retail-2026-10-08.1",
			audience: "annual" as const,
			credits: "24",
			standardCredits: "24",
			annualCredits: "24",
			savedCredits: "0",
			annualSavingsCredits: "0",
		};
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en}>
				<VideoAnnualBadge pricing={pricing} />
				<VideoRetailPrice pricing={pricing} />
			</NextIntlClientProvider>,
		);
		expect(markup).toContain("24 credits");
		expect(markup).toContain("Same price");
		expect(markup).not.toMatch(/<s>|video-annual-badge|Save 0/);
	});
	it("renders a verified brand icon and no manual generation-mode selector", () => {
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en}>
				<VideoSettings
					draft={initialVideoDraft}
					models={[]}
					onChange={vi.fn()}
					disabled={false}
					preview
				/>
			</NextIntlClientProvider>,
		);
		expect(markup).not.toContain('id="video-mode"');
		expect(markup).toContain('data-model-icon="kling"');
		expect(markup).toContain("/images/model-logos/kling.svg");
	});
	it.each([
		{
			locale: "en",
			messages: en,
			text: "Video pricing is temporarily unavailable. Please check back later.",
		},
		{
			locale: "de",
			messages: de,
			text: "Videopreise sind vorübergehend nicht verfügbar. Bitte schau später wieder vorbei.",
		},
		{
			locale: "es",
			messages: es,
			text: "Los precios de vídeo no están disponibles temporalmente. Vuelve a consultar más tarde.",
		},
		{
			locale: "fr",
			messages: fr,
			text: "Les tarifs vidéo sont temporairement indisponibles. Veuillez revenir plus tard.",
		},
	])("explains expired pricing clearly in $locale", ({ locale, messages, text }) => {
		function PriceError() {
			const t = useTranslations("videoV1");
			return <p role="alert">{t(`errors.${getVideoErrorKey({ code: "VIDEO_PRICE_EXPIRED" })}`)}</p>;
		}
		const onError = vi.fn();
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC" onError={onError}>
				<PriceError />
			</NextIntlClientProvider>,
		);
		expect(markup).toContain(text);
		expect(onError).not.toHaveBeenCalled();
	});
	it("opens each template history entry in its own workbench and preserves duet mode", () => {
		const markup = renderToStaticMarkup(
			<NextIntlClientProvider locale="en" messages={en}>
				<VideoHistory />
			</NextIntlClientProvider>,
		);
		expect(markup).toContain('href="/video-effects/hotel-lobby-ai?job=hotel-lobby-duo"');
		expect(markup).toContain('href="/blog/raindance-ai-trend?job=raindance-solo"');
		expect(markup).toContain('href="/blog/raindance-ai-trend?job=raindance-duo&amp;mode=duo"');
		expect(markup).toContain('href="/video?job=ordinary"');
	});
	it.each([
		{ locale: "en", messages: en },
		{ locale: "de", messages: de },
	])(
		"keeps sound enabled without a retired audio-review notice in $locale",
		({ locale, messages }) => {
			const draft = { ...initialVideoDraft, sound: true };
			const onError = vi.fn();
			const markup = renderToStaticMarkup(
				<NextIntlClientProvider
					locale={locale}
					messages={messages}
					timeZone="UTC"
					onError={onError}
				>
					<VideoSettings
						draft={draft}
						models={[
							{
								productKey: draft.productKey,
								available: true,
								options: getVideoModelOptions(draft.productKey, draft.mode).map((option) => ({
									...option,
									mode: draft.mode,
									available: true,
									credits: null,
								})),
							},
						]}
						onChange={vi.fn()}
						disabled={false}
					/>
				</NextIntlClientProvider>,
			);
			expect(markup).toContain('data-test="video-settings-trigger"');
			expect(markup).toContain(`<span>${messages.videoV1.soundOn}</span>`);
			expect(markup).not.toMatch(
				/audioReviewHint|spoken-content review|Prüfung gesprochener Inhalte/,
			);
			expect(onError).not.toHaveBeenCalled();
		},
	);
	it.each([
		"QUEUED",
		"INPUT_REVIEW",
		"SUBMITTING",
		"SUBMISSION_UNCERTAIN",
		"GENERATING",
		"STORING",
		"OUTPUT_REVIEW",
		"FINALIZING",
		"REJECTED",
		"FAILED",
		"NEEDS_REVIEW",
	] as const)(
		"never provides playback or download during %s, even if an inconsistent flag is received",
		(stage) => {
			const markup = render(stage, true);
			expect(markup).not.toContain("<video");
			expect(markup).not.toContain("Download MP4");
			expect(markup).toContain("23 credits reserved");
		},
	);
	it("requires an authorized READY result and does not fake sound-free output with muted", () => {
		expect(render("READY", false)).not.toContain("<video");
		const markup = render("READY", true);
		expect(markup).toContain("<video");
		expect(markup).toContain("Download MP4");
		expect(markup).not.toMatch(/<video[^>]*\smuted(?:[=\s>])/);
	});
	it("explains uncertainty without claiming generation or offering paid retry", () => {
		const markup = render("SUBMISSION_UNCERTAIN");
		expect(markup).toContain("will not submit it again automatically");
		expect(markup).not.toContain("<button");
		expect(markup).not.toContain("%");
	});
});
