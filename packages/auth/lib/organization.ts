import { getOrganizationWithPurchasesAndMembersCount } from "@repo/database";
import { logger } from "@repo/logs";
import { setProviderSubscriptionSeats } from "@repo/payments";

export async function updateSeatsInOrganizationSubscription(organizationId: string) {
	const organization = await getOrganizationWithPurchasesAndMembersCount(organizationId);

	if (!organization?.purchases.length) {
		return;
	}

	const activeSubscription = organization.purchases.find(
		(purchase) => purchase.type === "SUBSCRIPTION",
	);

	if (!activeSubscription?.subscriptionId) {
		return;
	}

	try {
		await setProviderSubscriptionSeats(
			activeSubscription.provider,
			activeSubscription.subscriptionId,
			organization.membersCount,
		);
	} catch (error) {
		logger.error("Could not update seats in organization subscription", {
			organizationId,
			error,
		});
	}
}
