import type { OrganizationMetadata } from "@repo/auth";
import { authClient } from "@repo/auth/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
	activeOrganizationQueryKey,
	fullOrganizationQueryKey,
	organizationListQueryKey,
	type ActiveOrganizationIdentifier,
} from "./query-cache";

export {
	activeOrganizationQueryKey,
	fullOrganizationQueryKey,
	invalidateOrganizationQueries,
	organizationListQueryKey,
	type ActiveOrganizationIdentifier,
} from "./query-cache";

export const useOrganizationListQuery = () => {
	return useQuery({
		queryKey: organizationListQueryKey,
		queryFn: async () => {
			const { data, error } = await authClient.organization.list();

			if (error) {
				throw new Error(error.message || "Failed to fetch organizations");
			}

			return data;
		},
	});
};

export const useActiveOrganizationQuery = (
	identifier: ActiveOrganizationIdentifier,
	options?: {
		enabled?: boolean;
	},
) => {
	const { slug, id } = identifier;
	const cacheKey = slug || id || "";

	return useQuery({
		queryKey: activeOrganizationQueryKey(identifier),
		queryFn: async () => {
			if (!slug && !id) {
				throw new Error("Either slug or id must be provided to fetch organization");
			}
			const { data, error } = await authClient.organization.getFullOrganization({
				query: slug ? { organizationSlug: slug } : { organizationId: id as string },
			});

			if (error) {
				throw new Error(error.message || "Failed to fetch active organization");
			}

			return data;
		},
		enabled: (options?.enabled ?? true) && !!cacheKey,
	});
};

export const useFullOrganizationQuery = (id: string) => {
	return useQuery({
		queryKey: fullOrganizationQueryKey(id),
		queryFn: async () => {
			const { data, error } = await authClient.organization.getFullOrganization({
				query: {
					organizationId: id,
				},
			});

			if (error) {
				throw new Error(error.message || "Failed to fetch full organization");
			}

			return data;
		},
	});
};

/*
 * Create organization
 */
export const createOrganizationMutationKey = ["create-organization"] as const;
export const useCreateOrganizationMutation = () => {
	return useMutation({
		mutationKey: createOrganizationMutationKey,
		mutationFn: async ({ name, metadata }: { name: string; metadata?: OrganizationMetadata }) => {
			const { slug } = await orpcClient.organizations.generateSlug({
				name,
			});

			const { error, data } = await authClient.organization.create({
				name,
				slug,
				metadata,
			});

			if (error) {
				throw error;
			}

			return data;
		},
	});
};

/*
 * Update organization
 */
export const updateOrganizationMutationKey = ["update-organization"] as const;
export const useUpdateOrganizationMutation = () => {
	return useMutation({
		mutationKey: updateOrganizationMutationKey,
		mutationFn: async ({
			id,
			name,
			metadata,
			updateSlug,
		}: {
			id: string;
			name: string;
			metadata?: OrganizationMetadata;
			updateSlug?: boolean;
		}) => {
			const slug = updateSlug
				? (
						await orpcClient.organizations.generateSlug({
							name,
						})
					).slug
				: undefined;

			const { error, data } = await authClient.organization.update({
				organizationId: id,
				data: {
					name,
					slug,
					metadata,
				},
			});

			if (error) {
				throw error;
			}

			return data;
		},
	});
};
