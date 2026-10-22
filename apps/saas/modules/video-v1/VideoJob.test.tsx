import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	playback: vi.fn(),
	job: {
		data: undefined as unknown,
		isPending: false,
		isError: false,
		isFetching: false,
		refetch: vi.fn(),
	},
}));
vi.mock("./api", () => ({ videoApi: { jobs: { playback: fixture.playback } } }));
vi.mock("./use-video", () => ({ usePageVisible: () => true, useVideoJob: () => fixture.job }));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "owner", isAnonymous: false } }),
}));
vi.mock("@shared/hooks/generation-analytics", () => ({ useGenerationAnalytics: vi.fn() }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

import { VideoJob, videoPlaybackQueryOptions } from "./VideoJob";

let client: QueryClient;
let cleanups: Array<() => void>;
const grant = () => ({
	url: "/api/video-v1/jobs/job/content?expires=9999999999999&signature=fixture&download=0",
	expiresAt: new Date(Date.now() + 300_000).toISOString(),
	ownerId: "owner",
});
function observe(playback = undefined as ReturnType<typeof grant> | undefined, ownerId = "owner") {
	const observer = new QueryObserver(
		client,
		videoPlaybackQueryOptions({ ownerId, jobId: "job", visible: true, playback }),
	);
	cleanups.push(observer.subscribe(() => undefined));
	return observer;
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
	vi.clearAllMocks();
	client = new QueryClient();
	cleanups = [];
	fixture.job.isError = false;
	fixture.job.data = undefined;
	fixture.playback.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		const { ownerId: _owner, ...value } = grant();
		return value;
	});
});
afterEach(() => {
	for (const cleanup of cleanups) cleanup();
	client.clear();
	vi.useRealTimers();
});

describe("inline video playback authorization", () => {
	it("makes the media URL available immediately without another playback request", async () => {
		const start = Date.now();
		const observer = observe(grant());
		expect(observer.getCurrentResult().data?.url).toContain("/jobs/job/content?");
		expect(observer.getCurrentResult().isFetching).toBe(false);
		expect(Date.now() - start).toBe(0);
		await vi.advanceTimersByTimeAsync(250);
		expect(fixture.playback).not.toHaveBeenCalled();
	});
	it("keeps the old-cache fallback and exposes its full simulated extra round trip", async () => {
		const start = Date.now();
		const observer = observe();
		expect(observer.getCurrentResult().data).toBeUndefined();
		await vi.advanceTimersByTimeAsync(249);
		expect(observer.getCurrentResult().data).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(observer.getCurrentResult().data?.url).toContain("/jobs/job/content?");
		expect(Date.now() - start).toBe(250);
		expect(fixture.playback).toHaveBeenCalledExactlyOnceWith({ jobId: "job" });
	});
	it.each(["expired", "wrong-owner", "wrong-job"])(
		"refreshes an unusable %s inline grant",
		async (reason) => {
			const value = grant();
			if (reason === "expired") value.expiresAt = new Date(Date.now()).toISOString();
			if (reason === "wrong-owner") value.ownerId = "other";
			if (reason === "wrong-job") value.url = value.url.replace("/jobs/job/", "/jobs/other/");
			const observer = observe(value);
			expect(observer.getCurrentResult().data).toBeUndefined();
			await vi.advanceTimersByTimeAsync(250);
			expect(fixture.playback).toHaveBeenCalledOnce();
		},
	);
	it("does not seed the next account with the previous owner's playback grant", async () => {
		const value = grant();
		const observer = observe(value);
		observer.setOptions(
			videoPlaybackQueryOptions({
				ownerId: "next-owner",
				jobId: "job",
				visible: true,
				playback: value,
			}),
		);
		expect(observer.getCurrentResult().data).toBeUndefined();
		await vi.advanceTimersByTimeAsync(250);
		expect(fixture.playback).toHaveBeenCalledOnce();
	});
	it("still reauthorizes when the existing expiry timer or playback recovery refetches", async () => {
		const observer = observe(grant());
		fixture.playback.mockRejectedValueOnce(new Error("NOT_FOUND"));
		await observer.refetch();
		expect(fixture.playback).toHaveBeenCalledOnce();
		expect(observer.getCurrentResult().isError).toBe(true);
	});
	it("removes stale playback when the current status request is denied", () => {
		fixture.job.data = {
			jobId: "job",
			stage: "READY",
			canPlay: true,
			playback: grant(),
			creditState: "SETTLED",
			credits: "1",
		};
		fixture.job.isError = true;
		const markup = renderToStaticMarkup(createElement(VideoJob, { jobId: "job" }));
		expect(markup).toContain("jobUnavailable");
		expect(markup).not.toContain("<video");
		expect(markup).not.toContain('data-test="video-job"');
	});
});
