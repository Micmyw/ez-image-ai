import { NextIntlClientProvider } from "next-intl";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../../../../packages/i18n/translations/en/saas.json";
import type { VideoEffectState } from "../lib/api";

const mocks = vi.hoisted(() => ({
	user: null as { id: string; isAnonymous?: boolean } | null,
	visible: true,
	useInfiniteQuery: vi.fn(),
	list: vi.fn(),
	link: vi.fn(),
}));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: mocks.user }) }));
vi.mock("@tanstack/react-query", () => ({ useInfiniteQuery: mocks.useInfiniteQuery }));
vi.mock("../lib/api", () => ({ videoEffectsApi: { jobs: { list: mocks.list } } }));
vi.mock("../../video-v1/use-video", () => ({ usePageVisible: () => mocks.visible }));
vi.mock("next/link", () => ({
	default: ({ prefetch, children, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) => {
		mocks.link({ href: props.href, prefetch });
		return <a {...props}>{children}</a>;
	},
}));

import { VideoEffectHistory } from "./VideoEffectHistory";

function item(overrides: Partial<VideoEffectState> = {}): VideoEffectState {
	return {
		jobId: "owner-a-job",
		effectId: "hotel-lobby-duo",
		name: "Hotel Lobby duo",
		presetKey: "standard",
		templateVersion: "hotel-lobby-v1",
		stage: "GENERATING_VIDEO",
		creditState: "RESERVED",
		credits: "42",
		canPlay: false,
		failureCode: null,
		updatedAt: "2026-10-05T01:00:00.000Z",
		...overrides,
	};
}
function result(items: VideoEffectState[] = []) {
	return {
		data: { pages: [{ items, nextCursor: null }] },
		isPending: false,
		isError: false,
		isFetching: false,
		isFetchingNextPage: false,
		hasNextPage: false,
		refetch: vi.fn(),
		fetchNextPage: vi.fn(),
	};
}
function render() {
	return renderToStaticMarkup(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<VideoEffectHistory />
		</NextIntlClientProvider>,
	);
}
function queryOptions() {
	return mocks.useInfiniteQuery.mock.calls.at(-1)![0];
}
function queryWith(items: VideoEffectState[]) {
	return { state: { data: { pages: [{ items, nextCursor: null }] } } };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.user = { id: "owner-a" };
	mocks.visible = true;
	mocks.useInfiniteQuery.mockReturnValue(result());
});

describe("Hotel Lobby owned task history", () => {
	it.each([null, { id: "guest", isAnonymous: true }])(
		"does not read or render private history for an anonymous visitor",
		(user) => {
			mocks.user = user;
			expect(render()).toBe("");
			expect(mocks.useInfiniteQuery).not.toHaveBeenCalled();
			expect(mocks.list).not.toHaveBeenCalled();
		},
	);
	it("isolates the cached list by the signed-in account", () => {
		mocks.useInfiniteQuery.mockImplementation(({ queryKey }: { queryKey: string[] }) =>
			result(queryKey[2] === "owner-a" ? [item()] : []),
		);
		expect(render()).toContain("owner-a-job");
		expect(queryOptions().queryKey).toEqual(["video-effects", "history", "owner-a"]);
		mocks.user = { id: "owner-b" };
		expect(render()).not.toContain("owner-a-job");
		expect(queryOptions().queryKey).toEqual(["video-effects", "history", "owner-b"]);
	});
	it("paginates the template-only endpoint with twenty orders per page", async () => {
		render();
		const options = queryOptions();
		expect(options.initialPageParam).toBeNull();
		await options.queryFn({ pageParam: null });
		await options.queryFn({ pageParam: "next-page" });
		expect(mocks.list.mock.calls).toEqual([[{ limit: 20 }], [{ limit: 20, cursor: "next-page" }]]);
		expect(options.getNextPageParam({ nextCursor: "next-page" })).toBe("next-page");
		expect(options.getNextPageParam({ nextCursor: null })).toBeUndefined();
	});
	it("links every order back to the template with its stage and credit status", () => {
		mocks.useInfiniteQuery.mockReturnValue(
			result([
				item({ jobId: "order /+?", stage: "READY", creditState: "SETTLED", canPlay: true }),
				item({ jobId: "failed-order", stage: "FAILED", creditState: "RELEASED", credits: "50" }),
				item({ jobId: "held-order", stage: "NEEDS_REVIEW" }),
			]),
		);
		const html = render();
		expect(html).toContain('id="hotel-lobby-history"');
		expect(html).toContain("/video-effects/hotel-lobby-ai?job=order%20%2F%2B%3F");
		expect(html).toContain(en.videoEffects.stages.READY);
		expect(html).toContain(en.videoEffects.stages.FAILED);
		expect(html).toContain(en.videoEffects.stages.NEEDS_REVIEW);
		expect(html).toContain(en.videoEffects.creditStates.SETTLED.replace("{credits}", "42"));
		expect(html).toContain(en.videoEffects.creditStates.RELEASED.replace("{credits}", "50"));
		expect(html).toContain(en.videoEffects.creditStates.RESERVED.replace("{credits}", "42"));
		expect(html).not.toContain('href="/video?');
		expect(html).not.toContain('href="/video/history');
		expect(mocks.link.mock.calls.map(([props]) => props)).toEqual([
			{ href: "/video-effects/hotel-lobby-ai?job=order%20%2F%2B%3F", prefetch: false },
			{ href: "/video-effects/hotel-lobby-ai?job=failed-order", prefetch: false },
			{ href: "/video-effects/hotel-lobby-ai?job=held-order", prefetch: false },
		]);
	});
	it("polls only a visible page with unfinished orders", () => {
		render();
		const options = queryOptions();
		expect(options.refetchInterval(queryWith([item()]))).toBe(2500);
		expect(options.refetchInterval(queryWith([]))).toBe(false);
		expect(options.refetchInterval({ state: {} })).toBe(false);
		expect(
			options.refetchInterval(
				queryWith([
					item({ stage: "READY" }),
					item({ stage: "FAILED" }),
					item({ stage: "NEEDS_REVIEW" }),
				]),
			),
		).toBe(false);
		expect(options.refetchIntervalInBackground).toBe(false);
		mocks.visible = false;
		render();
		expect(queryOptions().refetchInterval(queryWith([item()]))).toBe(false);
	});
	it("renders empty, loading and recoverable error states", () => {
		expect(render()).toContain(en.videoEffects.emptyHistory);
		mocks.useInfiniteQuery.mockReturnValue({ ...result(), isPending: true });
		const loading = render();
		expect(loading).toContain(`<output>${en.videoEffects.loading}</output>`);
		expect(loading).not.toContain(en.videoEffects.emptyHistory);
		mocks.useInfiniteQuery.mockReturnValue({ ...result(), isError: true });
		const error = render();
		expect(error).toContain('role="alert"');
		expect(error).toContain(en.videoEffects.statusUnavailable);
		expect(error).toContain(en.videoEffects.refreshStatus);
		expect(error).not.toContain(en.videoEffects.emptyHistory);
	});
	it("offers more orders and disables repeated requests while fetching", () => {
		mocks.useInfiniteQuery.mockReturnValue({ ...result([item()]), hasNextPage: true });
		expect(render()).toContain(en.videoEffects.loadMore);
		mocks.useInfiniteQuery.mockReturnValue({
			...result([item()]),
			hasNextPage: true,
			isFetching: true,
			isFetchingNextPage: true,
		});
		const html = render();
		expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
		expect(html).not.toContain(en.videoEffects.loadMore);
		expect(html).toContain(en.videoEffects.loading);
	});
});
