import { APIError } from "better-auth/api";

interface OrganizationDeletionInput {
	organizationId: string;
	userId: string;
}

interface OrganizationDeletionPurchase {
	type: "SUBSCRIPTION" | "ONE_TIME";
	subscriptionId: string | null;
}

interface OrganizationDeletionDependencies {
	findMembership: (organizationId: string, userId: string) => Promise<{ role: string } | null>;
	listPurchases: (organizationId: string) => Promise<OrganizationDeletionPurchase[]>;
	cancelSubscription: (subscriptionId: string) => Promise<void>;
}

export async function cancelOrganizationSubscriptionsBeforeDeletion(
	input: OrganizationDeletionInput,
	dependencies: OrganizationDeletionDependencies,
) {
	const membership = await dependencies.findMembership(input.organizationId, input.userId);
	const roles = membership?.role.split(",").map((role) => role.trim()) ?? [];

	if (!roles.includes("owner")) {
		throw new APIError("FORBIDDEN", {
			code: "ORGANIZATION_OWNER_REQUIRED",
			message: "Only an organization owner can delete this organization.",
		});
	}

	const purchases = await dependencies.listPurchases(input.organizationId);
	const subscriptionIds = new Set(
		purchases.flatMap((purchase) =>
			purchase.type === "SUBSCRIPTION" && purchase.subscriptionId ? [purchase.subscriptionId] : [],
		),
	);

	for (const subscriptionId of subscriptionIds) {
		await dependencies.cancelSubscription(subscriptionId);
	}
}
