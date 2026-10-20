import { QueryClient, type Query } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoCatalog } from "./api";

const fixture = vi.hoisted(() => ({
	client: null as QueryClient | null,
	mode: "video" as "video" | "image",
	visible: true,
	options: null as {
		enabled?: boolean;
		refetchInterval?: (query: { state: { data?: Partial<VideoCatalog> } }) => number | false;
		refetchIntervalInBackground?: boolean;
	} | null,
	cleanups: [] as Array<() => void>,
}));
vi.mock("react", () => ({
	useEffect: (effect: () => void | (() => void)) => {
		const cleanup = effect();
		if (cleanup) fixture.cleanups.push(cleanup);
	},
	useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock("@auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "owner-a", isAnonymous: false } }),
}));
vi.mock("@media/lib/generation-mode-context", () => ({
	useGenerationMode: () => ({ mode: fixture.mode }),
}));
vi.mock("@media/hooks/use-page-visible", () => ({ usePageVisible: () => fixture.visible }));
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
vi.mock("./api", () => ({ videoApi: { catalog: vi.fn() } }));

import { useVideoCatalog } from "./use-video";

beforeEach(() => {
	vi.useFakeTimers();
	fixture.client = new QueryClient();
	fixture.mode = "video";
	fixture.visible = true;
	fixture.options = null;
	fixture.cleanups = [];
});
afterEach(() => {
	for (const cleanup of fixture.cleanups) cleanup();
	fixture.client?.clear();
	vi.useRealTimers();
});

describe("video catalog qualification refresh", () => {
	it("refreshes a continuously visible catalog and schedules the known qualification expiry", () => {
		useVideoCatalog();
		const interval = fixture.options?.refetchInterval;
		expect(interval).toBeTypeOf("function");
		expect(interval?.({ state: {} })).toBe(30_000);
		const soon = { pricingValidUntil: new Date(Date.now() + 5_000).toISOString() };
		expect(interval?.({ state: { data: soon } })).toBeGreaterThanOrEqual(5_000);
		expect(interval?.({ state: { data: soon } })).toBeLessThan(5_100);
		const expired = { pricingValidUntil: new Date(Date.now() - 1).toISOString() };
		expect(interval?.({ state: { data: expired } })).toBe(30_000);
		expect(fixture.options?.refetchIntervalInBackground).toBe(false);
	});
	it.each([
		{ mode: "image" as const, visible: true },
		{ mode: "video" as const, visible: false },
	])("suspends catalog reads outside its visible mode: %o", (visibility) => {
		Object.assign(fixture, visibility);
		useVideoCatalog();
		expect(fixture.options?.enabled).toBe(false);
		expect(fixture.options?.refetchInterval?.({ state: {} })).toBe(false);
	});
	it.each(["success", "invalidate"])(
		"refreshes only the current owner's catalog on a payment query %s",
		(action) => {
			const client = fixture.client!;
			const key = [["payments", "listPurchases"], { input: {} }];
			client.setQueryData(key, []);
			const invalidate = vi.spyOn(client, "invalidateQueries");
			useVideoCatalog();
			client.setQueryData(["unrelated"], {});
			expect(invalidate).not.toHaveBeenCalled();
			if (action === "success") client.setQueryData(key, [{ id: "changed-subscription" }]);
			else (client.getQueryCache().find({ queryKey: key }) as Query).invalidate();
			expect(invalidate).toHaveBeenCalledWith(
				{ queryKey: ["video-v1", "catalog", "owner-a"], exact: true },
				{ cancelRefetch: false },
			);
		},
	);
});
