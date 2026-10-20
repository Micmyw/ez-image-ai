import type { QueryClient } from "@tanstack/react-query";

export const organizationListQueryKey = ["user", "organizations"] as const;

export interface ActiveOrganizationIdentifier {
	slug?: string;
	id?: string;
}

export const activeOrganizationQueryKey = (identifier: ActiveOrganizationIdentifier) =>
	[
		"user",
		"activeOrganization",
		identifier.slug ? "slug" : "id",
		identifier.slug || identifier.id || "",
	] as const;

export const fullOrganizationQueryKey = (id: string) => ["fullOrganization", id] as const;

/** Seed aliases only from an authorized full-organization response, never placeholder data. */
export function seedOrganizationQueries<T extends { id: string; slug: string; members: unknown[] }>(
	queryClient: QueryClient,
	organization: T,
) {
	queryClient.setQueryData(fullOrganizationQueryKey(organization.id), organization);
	queryClient.setQueryData(activeOrganizationQueryKey({ slug: organization.slug }), organization);
	queryClient.setQueryData(activeOrganizationQueryKey({ id: organization.id }), organization);
}

/** Keep member/role/invitation views and the active-organization context consistent. */
export function invalidateOrganizationQueries(queryClient: QueryClient, organizationId: string) {
	const organization = queryClient.getQueryData<{ id: string; slug: string }>(
		fullOrganizationQueryKey(organizationId),
	);
	const slug = organization?.id === organizationId ? organization.slug : undefined;

	return queryClient.invalidateQueries({
		predicate: ({ queryKey, state }) => {
			if (queryKey[0] === "fullOrganization") return queryKey[1] === organizationId;
			if (queryKey[0] !== "user" || queryKey[1] !== "activeOrganization") return false;
			return (
				(queryKey[2] === "id" && queryKey[3] === organizationId) ||
				(queryKey[2] === "slug" && slug !== undefined && queryKey[3] === slug) ||
				(state.data !== null &&
					typeof state.data === "object" &&
					"id" in state.data &&
					state.data.id === organizationId)
			);
		},
	});
}
