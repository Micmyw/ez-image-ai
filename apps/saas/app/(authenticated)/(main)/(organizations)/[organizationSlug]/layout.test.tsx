import {
	activeOrganizationQueryKey,
	fullOrganizationQueryKey,
} from "@organizations/lib/query-cache";
import { createQueryClient } from "@shared/lib/query-client";
import { hydrate, HydrationBoundary } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getActiveOrganization: vi.fn(),
	listPurchases: vi.fn(),
	payments: { billingAttachedTo: "user" },
}));
vi.mock("@auth/lib/server", () => ({ getActiveOrganization: mocks.getActiveOrganization }));
vi.mock("@payments/lib/server", () => ({ listPurchases: mocks.listPurchases }));
vi.mock("@repo/payments/config", () => ({ config: mocks.payments }));
vi.mock("@shared/components/AppWrapper", () => ({ AppWrapper: "app-wrapper" }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		payments: {
			listPurchases: {
				queryKey: ({ input }: { input: { organizationId: string } }) => [
					"purchases",
					input.organizationId,
				],
			},
		},
	},
}));

import OrganizationLayout from "./layout";

describe("organization layout hydration", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.payments.billingAttachedTo = "user";
		mocks.getActiveOrganization.mockResolvedValue({
			id: "authorized-id",
			slug: "team",
			members: [{ userId: "member" }],
		});
		mocks.listPurchases.mockResolvedValue([]);
	});

	it("hydrates the members query from the real authorized ID", async () => {
		const layout = await OrganizationLayout({
			children: "members",
			params: Promise.resolve({ organizationSlug: "team" }),
		});
		expect(layout.type).toBe(HydrationBoundary);
		const browserClient = createQueryClient();
		hydrate(browserClient, layout.props.state);
		const refetch = vi.fn();
		expect(
			await browserClient.fetchQuery({
				queryKey: fullOrganizationQueryKey("authorized-id"),
				queryFn: refetch,
			}),
		).toMatchObject({ id: "authorized-id", members: [{ userId: "member" }] });
		expect(refetch).not.toHaveBeenCalled();
		expect(browserClient.getQueryData(fullOrganizationQueryKey("team"))).toBeUndefined();
		expect(browserClient.getQueryData(activeOrganizationQueryKey({ slug: "team" }))).toMatchObject({
			id: "authorized-id",
		});
		expect(mocks.listPurchases).not.toHaveBeenCalled();
		browserClient.clear();
	});

	it("cannot hydrate a different organization from an earlier layout", async () => {
		await OrganizationLayout({
			children: null,
			params: Promise.resolve({ organizationSlug: "team" }),
		});
		mocks.getActiveOrganization.mockResolvedValue({ id: "org-b", slug: "team-b", members: [] });
		const layout = await OrganizationLayout({
			children: null,
			params: Promise.resolve({ organizationSlug: "team-b" }),
		});
		expect(layout.props.state.queries).toHaveLength(3);
		for (const query of layout.props.state.queries) {
			expect(query.state.data).toMatchObject({ id: "org-b" });
		}
	});

	it("returns not found without hydrating or loading billing when authorization fails", async () => {
		mocks.getActiveOrganization.mockResolvedValue(null);
		await expect(
			OrganizationLayout({
				children: null,
				params: Promise.resolve({ organizationSlug: "forbidden" }),
			}),
		).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
		expect(mocks.listPurchases).not.toHaveBeenCalled();
	});

	it("preserves organization billing prefetch under the authorized ID", async () => {
		mocks.payments.billingAttachedTo = "organization";
		const layout = await OrganizationLayout({
			children: null,
			params: Promise.resolve({ organizationSlug: "team" }),
		});
		expect(mocks.listPurchases).toHaveBeenCalledWith("authorized-id");
		expect(
			layout.props.state.queries.map((query: { queryKey: unknown }) => query.queryKey),
		).toContainEqual(["purchases", "authorized-id"]);
	});
});
