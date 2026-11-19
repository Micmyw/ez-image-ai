import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getGuestCapabilityPresentation: vi.fn() }));
vi.mock("./guest-draft-client", () => mocks);

import { guestCapabilityQueryOptions, refreshGuestCapability } from "./guest-capability-query";

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("guest capability browser cache", () => {
	it("deduplicates overlapping and fresh requests, and refreshes after the short TTL", async () => {
		vi.useFakeTimers();
		const client = new QueryClient();
		mocks.getGuestCapabilityPresentation.mockResolvedValue({ version: "v1" });
		await Promise.all([
			client.fetchQuery(guestCapabilityQueryOptions),
			client.fetchQuery(guestCapabilityQueryOptions),
		]);
		await client.fetchQuery(guestCapabilityQueryOptions);
		expect(mocks.getGuestCapabilityPresentation).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(30_001);
		await client.fetchQuery(guestCapabilityQueryOptions);
		expect(mocks.getGuestCapabilityPresentation).toHaveBeenCalledTimes(2);
		client.clear();
	});
	it("explicit retry invalidates the same fresh key without touching the catalog", async () => {
		const client = new QueryClient();
		client.setQueryData(["media-catalog"], { products: [] });
		mocks.getGuestCapabilityPresentation
			.mockResolvedValueOnce({ version: "v1" })
			.mockResolvedValueOnce({ version: "v2" });
		await client.fetchQuery(guestCapabilityQueryOptions);
		expect(await refreshGuestCapability(client)).toEqual({ version: "v2" });
		expect(mocks.getGuestCapabilityPresentation).toHaveBeenCalledTimes(2);
		expect(client.getQueryData(["media-catalog"])).toEqual({ products: [] });
		client.clear();
	});
});
