import { getActiveOrganization } from "@auth/lib/server";
import { seedOrganizationQueries } from "@organizations/lib/query-cache";
import { listPurchases } from "@payments/lib/server";
import { config as paymentsConfig } from "@repo/payments/config";
import { AppWrapper } from "@shared/components/AppWrapper";
import { orpc } from "@shared/lib/orpc-query-utils";
import { createQueryClient } from "@shared/lib/query-client";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import type { PropsWithChildren } from "react";

export default async function OrganizationLayout({
	children,
	params,
}: PropsWithChildren<{
	params: Promise<{
		organizationSlug: string;
	}>;
}>) {
	const { organizationSlug } = await params;

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		return notFound();
	}

	const queryClient = createQueryClient();
	seedOrganizationQueries(queryClient, organization);

	if (paymentsConfig.billingAttachedTo === "organization") {
		await queryClient.prefetchQuery({
			queryKey: orpc.payments.listPurchases.queryKey({
				input: {
					organizationId: organization.id,
				},
			}),
			queryFn: () => listPurchases(organization.id),
		});
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<AppWrapper>{children}</AppWrapper>
		</HydrationBoundary>
	);
}
