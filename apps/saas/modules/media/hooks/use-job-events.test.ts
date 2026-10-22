import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	client: { cancelQueries: vi.fn(), refetchQueries: vi.fn() },
	cleanups: [] as Array<() => void>,
	connections: [] as Array<{
		jobId: string;
		url: string;
		refresh(): Promise<unknown>;
		close: ReturnType<typeof vi.fn>;
	}>,
}));
vi.mock("react", () => ({
	useEffect: (effect: () => undefined | (() => void)) => {
		const cleanup = effect();
		if (cleanup) fixture.cleanups.push(cleanup);
	},
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => fixture.client }));
vi.mock("../lib/job-events", () => ({
	connectMediaJobEvents: (input: { jobId: string; url: string; refresh(): Promise<unknown> }) => {
		const close = vi.fn();
		fixture.connections.push({ ...input, close });
		return close;
	},
}));

import { useJobEvents } from "./use-job-events";

const options = (ownerId = "owner-a") => ({
	jobId: "job",
	ownerId,
	enabled: true,
	queryKey: ["media-job", "job", ownerId],
});
beforeEach(() => {
	fixture.client = {
		cancelQueries: vi.fn().mockResolvedValue(undefined),
		refetchQueries: vi.fn().mockResolvedValue(undefined),
	};
	fixture.cleanups = [];
	fixture.connections = [];
	vi.stubGlobal("window", { location: { href: "https://app.example/create" } });
	vi.stubGlobal("WebSocket", function WebSocket() {});
});
afterEach(() => {
	for (const cleanup of fixture.cleanups.splice(0)) cleanup();
	vi.unstubAllGlobals();
});

describe("shared owner-scoped result subscription lifecycle", () => {
	it("shares a socket across components observing the same job and closes on the last unmount", () => {
		useJobEvents(options());
		useJobEvents(options());
		expect(fixture.connections).toHaveLength(1);
		expect(fixture.connections[0]?.url).toBe("wss://app.example/api/media/jobs/job/events");
		fixture.cleanups.shift()!();
		expect(fixture.connections[0]?.close).not.toHaveBeenCalled();
		fixture.cleanups.shift()!();
		expect(fixture.connections[0]?.close).toHaveBeenCalledTimes(1);
	});
	it("reads fresh authorized state after cancelling a request which may predate the commit", async () => {
		useJobEvents(options());
		await fixture.connections[0]!.refresh();
		expect(fixture.client.cancelQueries).toHaveBeenCalledExactlyOnceWith({
			queryKey: options().queryKey,
			exact: true,
		});
		expect(fixture.client.refetchQueries).toHaveBeenCalledExactlyOnceWith(
			{ queryKey: options().queryKey, exact: true, type: "active" },
			{ throwOnError: true },
		);
		expect(fixture.client.cancelQueries.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.client.refetchQueries.mock.invocationCallOrder[0]!,
		);
	});
	it("does not continue an old owner refresh after account switch", async () => {
		let resolve!: () => void;
		fixture.client.cancelQueries.mockImplementationOnce(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		);
		useJobEvents(options());
		const oldRefresh = fixture.connections[0]!.refresh();
		fixture.cleanups.shift()!();
		useJobEvents(options("owner-b"));
		resolve();
		await oldRefresh;
		expect(fixture.client.refetchQueries).not.toHaveBeenCalled();
		expect(fixture.connections).toHaveLength(2);
		expect(fixture.connections[0]?.close).toHaveBeenCalledTimes(1);
	});
	it("does not report an authorized read as successful when its query fails", async () => {
		useJobEvents(options());
		fixture.client.refetchQueries.mockRejectedValueOnce(new Error("NOT_FOUND"));
		await expect(fixture.connections[0]!.refresh()).rejects.toThrow("NOT_FOUND");
	});
	it("does not connect in hidden/inactive mode or without an authenticated owner", () => {
		useJobEvents({ ...options(), enabled: false });
		useJobEvents({ ...options(), ownerId: undefined });
		expect(fixture.connections).toHaveLength(0);
	});
});
