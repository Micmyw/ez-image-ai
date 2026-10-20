import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	mode: undefined as "image" | "video" | undefined,
	visible: true,
	list: vi.fn(),
	poll: vi.fn(),
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "owner-a", isAnonymous: false } }),
}));
vi.mock("../lib/generation-mode-context", () => ({
	useGenerationMode: () => (fixture.mode ? { mode: fixture.mode } : null),
}));
vi.mock("./use-page-visible", () => ({ usePageVisible: () => fixture.visible }));
vi.mock("./use-active-history-polling", () => ({ useActiveHistoryPolling: fixture.poll }));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useInfiniteQuery: fixture.list,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { listJobs: vi.fn() } },
}));

import { jobHistoryQueryOptions, useJobHistory } from "./use-job-history";

beforeEach(() => {
	vi.clearAllMocks();
	fixture.mode = undefined;
	fixture.visible = true;
	fixture.list.mockReturnValue({ data: undefined });
});

describe("job history page queries", () => {
	it("does not periodically reload every cached page", () => {
		expect(jobHistoryQueryOptions({})).not.toHaveProperty("refetchInterval");
	});

	it("keeps status filters and owners in separate paginated caches", () => {
		const first = jobHistoryQueryOptions({ status: "active" }, "owner-a");
		const second = jobHistoryQueryOptions({ status: "active" }, "owner-b");
		const completed = jobHistoryQueryOptions({ status: "succeeded" }, "owner-a");
		expect(first.queryKey).not.toEqual(second.queryKey);
		expect(first.queryKey).not.toEqual(completed.queryKey);
		expect(first.initialPageParam).toBeUndefined();
	});

	it.each(["image", undefined] as const)(
		"keeps image history available in its active mode or standalone route: %s",
		(mode) => {
			fixture.mode = mode;
			useJobHistory({});
			expect(fixture.list.mock.calls.at(-1)?.[0].enabled).toBe(true);
			expect(fixture.poll.mock.calls.at(-1)?.[0].enabled).toBe(true);
		},
	);

	it("suspends the mounted recent image queue while video mode is selected", () => {
		fixture.mode = "video";
		useJobHistory({});
		expect(fixture.list.mock.calls.at(-1)?.[0].enabled).toBe(false);
		expect(fixture.poll.mock.calls.at(-1)?.[0].enabled).toBe(false);

		fixture.mode = "image";
		useJobHistory({});
		expect(fixture.list.mock.calls.at(-1)?.[0].enabled).toBe(true);
		expect(fixture.poll.mock.calls.at(-1)?.[0].enabled).toBe(true);
	});

	it("suspends targeted polling when the browser page is hidden", () => {
		fixture.visible = false;
		useJobHistory({});
		expect(fixture.poll.mock.calls.at(-1)?.[0].enabled).toBe(false);
	});
});
