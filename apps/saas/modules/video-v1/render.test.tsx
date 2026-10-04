import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import en from "../../../../packages/i18n/translations/en/saas.json";
import type { VideoState } from "./api";

vi.mock("./api", () => ({ videoApi: { jobs: { playback: vi.fn() } } }));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "owner-1", isAnonymous: false } }),
}));
vi.mock("./use-video", () => ({ usePageVisible: () => true, useVideoJob: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: { url: "/api/video-v1/mock-private?expires=1", expiresAt: "2030-01-01T00:00:00Z" },
		isPending: false,
		isError: false,
		refetch: vi.fn(),
	}),
}));

import { VideoStateCard } from "./VideoJob";

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
