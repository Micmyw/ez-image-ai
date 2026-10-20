import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getFullOrganization: vi.fn() }));
vi.mock("@repo/auth/client", () => ({
	authClient: { organization: { getFullOrganization: mocks.getFullOrganization } },
}));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));
vi.mock("@tanstack/react-query", async (original) => ({
	...(await original<typeof import("@tanstack/react-query")>()),
	useQuery: (options: unknown) => options,
}));

import { useActiveOrganizationQuery } from "./api";
import { seedOrganizationQueries } from "./query-cache";

describe("active organization switching", () => {
	beforeEach(() => vi.resetAllMocks());

	it("does not show the previous organization's members while the next organization loads", () => {
		const client = new QueryClient();
		const a = { id: "org-a", slug: "team-a", members: [{ userId: "member-a" }] };
		seedOrganizationQueries(client, a);
		const optionsA = useActiveOrganizationQuery({ slug: "team-a" }, { enabled: true });
		const optionsB = useActiveOrganizationQuery({ slug: "team-b" }, { enabled: true });
		// The mocked hook exposes its real options to exercise an actual query observer.
		const observer = new QueryObserver(client, optionsA as never);
		expect(observer.getCurrentResult().data).toEqual(a);
		observer.setOptions(optionsB as never);
		expect(observer.getCurrentResult().data).toBeUndefined();
		expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
		observer.destroy();
		client.clear();
	});
});
