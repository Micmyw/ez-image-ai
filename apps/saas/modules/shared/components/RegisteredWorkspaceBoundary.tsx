import { sessionQueryKey } from "@auth/lib/api";
import { getOrganizationList, getSession } from "@auth/lib/server";
import { organizationListQueryKey } from "@organizations/lib/api";
import { listPurchases } from "@payments/lib/server";
import { config as authConfig } from "@repo/auth/config";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { config as paymentsConfig } from "@repo/payments/config";
import { RegisteredWorkspaceProviders } from "@shared/components/RegisteredWorkspaceProviders";
import { orpc } from "@shared/lib/orpc-query-utils";
import { getServerQueryClient } from "@shared/lib/server";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { getMessages } from "next-intl/server";
import { redirect } from "next/navigation";
import type { PropsWithChildren } from "react";

export async function RegisteredWorkspaceBoundary({ children }: PropsWithChildren) {
	const session = await getSession();

	if (!session) {
		redirect("/login");
	}
	if (isAnonymousUser(session.user)) {
		redirect("/try");
	}

	const queryClient = getServerQueryClient();

	queryClient.setQueryData(sessionQueryKey, session);
	const [{ imagePass, media, checkoutReturn, creditPackCheckoutReturn, settings, support }] =
		await Promise.all([
			getMessages(),
			authConfig.organizations.enable
				? queryClient.prefetchQuery({
						queryKey: organizationListQueryKey,
						queryFn: getOrganizationList,
					})
				: undefined,
			paymentsConfig.billingAttachedTo === "user"
				? queryClient.prefetchQuery({
						queryKey: orpc.payments.listPurchases.queryKey({ input: {} }),
						queryFn: () => listPurchases(),
					})
				: undefined,
		]);
	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			{/* Full payment/library copy is serialized only after the registered-user boundary. */}
			<RegisteredWorkspaceProviders
				imagePassMessages={imagePass}
				mediaMessages={media}
				checkoutReturnMessages={checkoutReturn}
				creditPackCheckoutReturnMessages={creditPackCheckoutReturn}
				settingsMessages={settings}
				supportMessages={support}
			>
				{children}
			</RegisteredWorkspaceProviders>
		</HydrationBoundary>
	);
}
