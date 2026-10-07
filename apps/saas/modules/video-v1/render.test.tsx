import { getVideoModelOptions } from "@repo/config/video-models";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import de from "../../../../packages/i18n/translations/de/saas.json";
import en from "../../../../packages/i18n/translations/en/saas.json";
import type { VideoState } from "./api";
import { initialVideoDraft } from "./model";

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
