import { getOrganizationList, getSession } from "@auth/lib/server";
import { listPurchases } from "@payments/lib/server";
import { config as authConfig } from "@repo/auth/config";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { config as paymentsConfig } from "@repo/payments/config";
import { createPurchasesHelper } from "@repo/payments/lib/helper";
import { redirect } from "next/navigation";
import type { PropsWithChildren } from "react";

export async function MainAccountBoundary({ children }: PropsWithChildren) {
	const session = await getSession();

	if (!session) {
		redirect("/login");
	}
	if (isAnonymousUser(session.user)) {
		redirect("/try");
	}

	if (authConfig.users.enableOnboarding && !session.user.onboardingComplete) {
		redirect("/onboarding");
	}

	const organizations = await getOrganizationList();

	if (authConfig.organizations.enable && authConfig.organizations.requireOrganization) {
		const organization =
			organizations.find((org) => org.id === session?.session.activeOrganizationId) ||
			organizations[0];

		if (!organization) {
			redirect("/new-organization");
		}
	}

	if (paymentsConfig.requireActiveSubscription) {
		const organizationId = authConfig.organizations.enable
			? session?.session.activeOrganizationId || organizations?.at(0)?.id
			: undefined;

		const purchases = await listPurchases(organizationId);

		const { activePlan } = createPurchasesHelper(purchases);

		if (!activePlan) {
			redirect("/choose-plan");
		}
	}

	return children;
}
