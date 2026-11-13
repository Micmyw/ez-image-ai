import { getOrganizationList, getSession } from "@auth/lib/server";
import {
	activePlanChoosePlanDestination,
	createChoosePlanPath,
} from "@payments/lib/editor-upgrade";
import { listPurchases } from "@payments/lib/server";
import { config as authConfig } from "@repo/auth/config";
import { config as paymentsConfig } from "@repo/payments/config";
import { createPurchasesHelper } from "@repo/payments/lib/helper";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata() {
	const t = await getTranslations("choosePlan");

	return {
		title: t("title"),
	};
}

export default async function ChoosePlanPage({
	searchParams,
}: {
	searchParams: Promise<{ returnTo?: string }>;
}) {
	const [session, { returnTo }] = await Promise.all([getSession(), searchParams]);

	if (!session) {
		redirect("/login");
	}

	let organizationId: string | undefined;
	if (authConfig.organizations.enable && paymentsConfig.billingAttachedTo === "organization") {
		const organization = (await getOrganizationList()).at(0);

		if (!organization) {
			redirect("/new-organization");
		}

		organizationId = organization.id;
	}

	const purchases = await listPurchases(organizationId);

	const { activePlan } = createPurchasesHelper(purchases);
	const activePlanDestination = activePlanChoosePlanDestination(activePlan?.id, returnTo);

	if (activePlanDestination) {
		redirect(activePlanDestination);
	}

	redirect(createChoosePlanPath(returnTo ?? "/create?upgrade=complete"));
}
