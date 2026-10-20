import { describe, expect, it, vi } from "vitest";

import { mergeActiveHistory, readActiveHistory } from "./active-history";

const item = (id: string, status = "RUNNING") => ({ id, status });
const getId = (value: ReturnType<typeof item>) => value.id;

describe("targeted history updates", () => {
	it("reads active jobs from all loaded pages once without fetching settled jobs", async () => {
		const read = vi.fn(async (id: string) => item(id, "READY"));
		const data = {
			pages: [
				{ items: [item("first"), item("done", "READY")], nextCursor: "page-2" },
				{ items: [item("middle")], nextCursor: "page-3" },
				{ items: [item("old"), item("first")], nextCursor: null },
			],
			pageParams: [null, "page-2", "page-3"],
		};
		const updates = await readActiveHistory({
			data,
			getId,
			isActive: (value) => value.status === "RUNNING",
			read,
			signal: new AbortController().signal,
		});
		expect(read.mock.calls.map(([id]) => id)).toEqual(["first", "middle", "old"]);
		const merged = mergeActiveHistory(data, updates, getId, (_, update) => update);
		expect(merged.pages.flatMap((page) => page.items.map((value) => value.status))).toEqual([
			"READY",
			"READY",
			"READY",
			"READY",
			"READY",
		]);
		expect(merged.pageParams).toBe(data.pageParams);
		expect(merged.pages.map((page) => (page as (typeof data.pages)[number]).nextCursor)).toEqual([
			"page-2",
			"page-3",
			null,
		]);
	});

	it("bounds concurrent reads and retains the last known state on an individual failure", async () => {
		let inFlight = 0;
		let peak = 0;
		const data = {
			pages: [{ items: Array.from({ length: 12 }, (_, index) => item(String(index))) }],
			pageParams: [null],
		};
		const updates = await readActiveHistory({
			data,
			getId,
			isActive: () => true,
			signal: new AbortController().signal,
			read: async (id) => {
				peak = Math.max(peak, ++inFlight);
				await Promise.resolve();
				inFlight--;
				if (id === "2") throw new Error("temporarily unavailable");
				return item(id, "READY");
			},
		});
		expect(peak).toBe(4);
		const merged = mergeActiveHistory(data, updates, getId, (_, update) => update);
		expect(merged.pages[0]?.items[2]).toBe(data.pages[0]?.items[2]);
		expect(updates.size).toBe(11);
	});

	it("drops an item leaving the active filter without altering page cursors or other rows", () => {
		const data = {
			pages: [{ items: [item("finished"), item("running")], nextCursor: "older" }],
			pageParams: [null],
		};
		const merged = mergeActiveHistory(
			data,
			new Map([["finished", item("finished", "READY")]]),
			getId,
			(_, update) => (update.status === "READY" ? null : update),
		);
		expect(merged.pages[0]?.items).toEqual([item("running")]);
		expect((merged.pages[0] as (typeof data.pages)[number]).nextCursor).toBe("older");
		expect(
			mergeActiveHistory(
				data,
				new Map([["finished", item("finished")]]),
				getId,
				(_, value) => value,
			),
		).toBe(data);
	});

	it("does not start or publish reads after its owner/visibility lifecycle ends", async () => {
		const controller = new AbortController();
		const read = vi.fn(async (id: string) => {
			controller.abort();
			return item(id, "READY");
		});
		const updates = await readActiveHistory({
			data: { pages: [{ items: [item("first"), item("old")] }], pageParams: [null] },
			getId,
			isActive: () => true,
			read,
			signal: controller.signal,
		});
		expect(read).toHaveBeenCalledTimes(1);
		expect(updates.size).toBe(0);
	});
});
