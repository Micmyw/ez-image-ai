import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	client: null as QueryClient | null,
	cleanups: [] as Array<() => void>,
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useRef: <T>(value: T) => ({ current: value }),
	useEffect: (effect: () => void | (() => void)) => {
		const cleanup = effect();
		if (cleanup) fixture.cleanups.push(cleanup);
	},
}));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useQueryClient: () => fixture.client,
}));

import { useActiveHistoryPolling } from "./use-active-history-polling";

const key = ["history", "owner-a"];
const row = (id: string, stage = "RUNNING") => ({ id, stage });
function history() {
	return {
		pages: [
			{ items: [row("new"), row("settled", "READY")], nextCursor: "older" },
			{ items: [row("old")], nextCursor: null },
		],
		pageParams: [null, "older"],
	};
}
function start(read: (id: string) => Promise<ReturnType<typeof row>>, enabled = true) {
	useActiveHistoryPolling({
		queryKey: key,
		data: fixture.client!.getQueryData<ReturnType<typeof history>>(key),
		enabled,
		interval: 2_000,
		getId: (item) => item.id,
		isActive: (item) => item.stage === "RUNNING",
		detailKey: (id) => ["job", "owner-a", id],
		read,
		merge: (_, update) => update,
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	fixture.client = new QueryClient();
	fixture.client.setQueryData(key, history());
	fixture.cleanups = [];
});
afterEach(() => {
	for (const cleanup of fixture.cleanups) cleanup();
	fixture.client?.clear();
	vi.useRealTimers();
});

describe("loaded history polling lifecycle", () => {
	it("updates active entries across old pages, keeps cursors, and stops reading terminal tasks", async () => {
		const read = vi.fn(async (id: string) => row(id, "READY"));
		const initial = fixture.client!.getQueryState(key)!.dataUpdatedAt;
		start(read);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(read.mock.calls.map(([id]) => id)).toEqual(["new", "old"]);
		const updated = fixture.client!.getQueryData<ReturnType<typeof history>>(key)!;
		expect(
			updated.pages.flatMap((page) => page.items).every((item) => item.stage === "READY"),
		).toBe(true);
		expect(updated.pages.map((page) => page.nextCursor)).toEqual(["older", null]);
		expect(updated.pageParams).toEqual([null, "older"]);
		expect(fixture.client!.getQueryState(key)!.dataUpdatedAt).toBe(initial);
		await vi.advanceTimersByTimeAsync(8_000);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("does not read while the page is hidden", async () => {
		const read = vi.fn(async (id: string) => row(id));
		start(read, false);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(read).not.toHaveBeenCalled();
	});

	it("does not overwrite a newer manual list refresh with in-flight detail responses", async () => {
		let resolve!: (value: ReturnType<typeof row>) => void;
		start((id) =>
			id === "new"
				? new Promise((done) => {
						resolve = done;
					})
				: Promise.resolve(row(id, "READY")),
		);
		await vi.advanceTimersByTimeAsync(2_000);
		const refreshed = history();
		refreshed.pages[0]!.items[0] = row("new", "FAILED");
		fixture.client!.setQueryData(key, refreshed);
		resolve(row("new", "READY"));
		await vi.advanceTimersByTimeAsync(1);
		expect(
			fixture.client!.getQueryData<ReturnType<typeof history>>(key)!.pages[0]!.items[0]!.stage,
		).toBe("FAILED");
	});

	it("waits for an older in-flight list response before publishing newer detail states", async () => {
		let resolveList!: (value: ReturnType<typeof history>) => void;
		const read = vi.fn(async (id: string) => row(id, "READY"));
		start(read);
		const listRequest = fixture.client!.fetchQuery({
			queryKey: key,
			queryFn: () =>
				new Promise<ReturnType<typeof history>>((resolve) => {
					resolveList = resolve;
				}),
		});

		await vi.advanceTimersByTimeAsync(2_000);
		expect(read.mock.calls.map(([id]) => id)).toEqual(["new", "old"]);
		expect(fixture.client!.getQueryState(key)?.fetchStatus).toBe("fetching");
		expect(fixture.client!.getQueryData(key)).toEqual(history());

		resolveList(history());
		await listRequest;
		await vi.advanceTimersByTimeAsync(2_000);
		const updated = fixture.client!.getQueryData<ReturnType<typeof history>>(key)!;
		expect(
			updated.pages.flatMap((page) => page.items).every((item) => item.stage === "READY"),
		).toBe(true);
	});

	it("does not publish an old owner's in-flight response after cleanup", async () => {
		const resolvers = new Map<string, (value: ReturnType<typeof row>) => void>();
		start(
			(id) =>
				new Promise((done) => {
					resolvers.set(id, done);
				}),
		);
		await vi.advanceTimersByTimeAsync(2_000);
		expect([...resolvers.keys()]).toEqual(["new", "old"]);
		for (const cleanup of fixture.cleanups) cleanup();
		for (const [id, resolve] of resolvers) resolve(row(id, "READY"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fixture.client!.getQueryData(key)).toEqual(history());
	});
});
