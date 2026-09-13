import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => vi.stubGlobal("window", {}));
afterAll(() => vi.unstubAllGlobals());

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { listJobs: vi.fn() } },
}));

import { jobHistoryQueryOptions } from "./use-job-history";

describe("job history refresh", () => {
	it("refreshes a finishing edit without a reload and stops when it is ready", async () => {
		vi.useFakeTimers();
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const listJobs = vi
			.fn()
			.mockResolvedValueOnce({ items: [{ id: "edit", status: "FINALIZING" }], nextCursor: null })
			.mockResolvedValue({ items: [{ id: "edit", status: "SUCCEEDED" }], nextCursor: null });
		const options = { ...jobHistoryQueryOptions({}), queryFn: listJobs, staleTime: Infinity };
		try {
			await client.fetchInfiniteQuery(options);
			const observer = new InfiniteQueryObserver(client, options);
			const unsubscribe = observer.subscribe(() => undefined);
			try {
				await vi.advanceTimersByTimeAsync(5_000);
				expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.status).toBe("SUCCEEDED");
				const completedCalls = listJobs.mock.calls.length;
				await vi.advanceTimersByTimeAsync(15_000);
				expect(listJobs).toHaveBeenCalledTimes(completedCalls);
			} finally {
				unsubscribe();
			}
		} finally {
			client.clear();
			vi.useRealTimers();
		}
	});
});
