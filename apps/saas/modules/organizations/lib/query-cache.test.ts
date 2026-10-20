import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
	activeOrganizationQueryKey,
	fullOrganizationQueryKey,
	invalidateOrganizationQueries,
	organizationListQueryKey,
	seedOrganizationQueries,
} from "./query-cache";

describe("organization query aliases", () => {
	it("shares an authorized full response without fetching again through its ID", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
		const organization = { id: "org-a", slug: "team-a", members: [{ role: "owner" }] };
		seedOrganizationQueries(client, organization);
		const fetch = vi.fn();
		expect(
			await client.fetchQuery({ queryKey: fullOrganizationQueryKey("org-a"), queryFn: fetch }),
		).toEqual(organization);
		expect(fetch).not.toHaveBeenCalled();
		expect(client.getQueryData(activeOrganizationQueryKey({ slug: "team-a" }))).toEqual(
			organization,
		);
		expect(client.getQueryData(activeOrganizationQueryKey({ id: "org-a" }))).toEqual(organization);
		client.clear();
	});

	it("keeps IDs and slugs in distinct namespaces, including a colliding organization slug", () => {
		const client = new QueryClient();
		const a = { id: "org-a", slug: "team-a", members: [{ userId: "a" }] };
		const b = { id: "org-b", slug: "org-a", members: [{ userId: "b" }] };
		seedOrganizationQueries(client, a);
		seedOrganizationQueries(client, b);
		expect(client.getQueryData(activeOrganizationQueryKey({ id: "org-a" }))).toEqual(a);
		expect(client.getQueryData(activeOrganizationQueryKey({ slug: "org-a" }))).toEqual(b);
		expect(client.getQueryData(fullOrganizationQueryKey("org-b"))).toEqual(b);
		expect(client.getQueryData(fullOrganizationQueryKey("missing"))).toBeUndefined();
		client.clear();
	});

	it("uses the ID when an empty slug falls back to the ID request", () => {
		expect(activeOrganizationQueryKey({ slug: "", id: "org-a" })).toEqual(
			activeOrganizationQueryKey({ id: "org-a" }),
		);
	});

	it("invalidates all aliases of the changed organization without invalidating another one", async () => {
		const client = new QueryClient();
		seedOrganizationQueries(client, { id: "org-a", slug: "team-a", members: [] });
		seedOrganizationQueries(client, { id: "org-b", slug: "org-a", members: [] });
		client.setQueryData(organizationListQueryKey, []);
		await invalidateOrganizationQueries(client, "org-a");
		for (const key of [
			fullOrganizationQueryKey("org-a"),
			activeOrganizationQueryKey({ id: "org-a" }),
			activeOrganizationQueryKey({ slug: "team-a" }),
		]) {
			expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		}
		for (const key of [
			fullOrganizationQueryKey("org-b"),
			activeOrganizationQueryKey({ id: "org-b" }),
			activeOrganizationQueryKey({ slug: "org-a" }),
			organizationListQueryKey,
		]) {
			expect(client.getQueryState(key)?.isInvalidated).toBe(false);
		}
		client.clear();
	});
});
