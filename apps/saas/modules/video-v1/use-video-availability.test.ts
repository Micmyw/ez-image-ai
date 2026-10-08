import { QueryClient, type Query } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	client: null as QueryClient | null,
	user: { id: "owner-a", isAnonymous: false } as { id: string; isAnonymous: boolean } | null,
	options: null as {
		queryKey: unknown[];
		queryFn: () => unknown;
		enabled: boolean;
		retry: boolean;
		refetchInterval: (query: { state: { data?: { pricingValidUntil?: string | null } } }) => number;
		refetchIntervalInBackground: boolean;
	} | null,
	cleanups: [] as Array<() => void>,
}));
vi.mock("react", () => ({
	useEffect: (effect: () => void | (() => void)) => {
		const cleanup = effect();
		if (cleanup) fixture.cleanups.push(cleanup);
	},
}));
vi.mock("@auth/hooks/use-session", () => ({ useSession: () => ({ user: fixture.user }) }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { payments: { key: () => [["payments"]] } },
}));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useQueryClient: () => fixture.client,
	useQuery: (options: typeof fixture.options) => {
		fixture.options = options;
		return {};
	},
}));
vi.mock("./api", () => ({
	videoApi: { availability: vi.fn(async () => ({ available: true })), catalog: vi.fn() },
}));

import { videoApi } from "./api";
import { useVideoAvailability } from "./use-video-availability";

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	fixture.client = new QueryClient();
	fixture.user = { id: "owner-a", isAnonymous: false };
	fixture.options = null;
	fixture.cleanups = [];
});
afterEach(() => {
	for (const cleanup of fixture.cleanups) cleanup();
	fixture.client?.clear();
	vi.useRealTimers();
});

describe("video navigation query", () => {
	it("loads only availability and scopes the cache to the signed-in owner", async () => {
		useVideoAvailability();
		expect(fixture.options?.queryKey).toEqual(["video-v1", "availability", "owner-a"]);
		await fixture.options?.queryFn();
		expect(videoApi.availability).toHaveBeenCalledOnce();
		expect(videoApi.catalog).not.toHaveBeenCalled();
		expect(fixture.options?.retry).toBe(false);
		fixture.user = { id: "owner-b", isAnonymous: false };
		useVideoAvailability();
		expect(fixture.options?.queryKey).toEqual(["video-v1", "availability", "owner-b"]);
	});
	it.each([null, { id: "guest", isAnonymous: true }])(
		"does not query for a visitor or anonymous principal",
		(user) => {
			fixture.user = user;
			useVideoAvailability();
			expect(fixture.options?.enabled).toBe(false);
		},
	);
	it("refreshes a visible page and the known qualification expiry", () => {
		useVideoAvailability();
		expect(fixture.options?.refetchInterval({ state: {} })).toBe(30_000);
		expect(
			fixture.options?.refetchInterval({
				state: { data: { pricingValidUntil: new Date(Date.now() + 5_000).toISOString() } },
			}),
		).toBe(5_025);
		expect(fixture.options?.refetchIntervalInBackground).toBe(false);
	});
	it.each(["success", "invalidate"])(
		"refreshes this owner's availability on payment %s",
		(action) => {
			const client = fixture.client!;
			const key = [["payments", "listPurchases"], { input: {} }];
			client.setQueryData(key, []);
			const invalidate = vi.spyOn(client, "invalidateQueries");
			useVideoAvailability();
			client.setQueryData(["unrelated"], {});
			expect(invalidate).not.toHaveBeenCalled();
			if (action === "success") client.setQueryData(key, [{ id: "changed-subscription" }]);
			else (client.getQueryCache().find({ queryKey: key }) as Query).invalidate();
			expect(invalidate).toHaveBeenCalledWith(
				{ queryKey: ["video-v1", "availability", "owner-a"], exact: true },
				{ cancelRefetch: false },
			);
		},
	);
});
