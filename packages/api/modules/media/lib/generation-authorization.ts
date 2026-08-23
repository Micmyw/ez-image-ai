import { getCatalogEntry, type MediaModelInput } from "@repo/ai";
import {
	DEFAULT_PRODUCT_CONFIG,
	PLAN_ENTITLEMENTS,
	type PlanId,
	type ProductModelKey,
} from "@repo/config";
import { db } from "@repo/database/client";

import { enforceMediaRateLimit } from "./rate-limit";

export interface GenerationAccessSnapshot {
	generationEnabled: boolean;
	modelEnabled: boolean;
	spendableCredits: bigint;
	dailyCostMicros: bigint;
	planId: PlanId;
	sourceAssetReady: boolean;
}

export interface GenerationAuthorizationInput {
	userId: string;
	productKey: ProductModelKey;
	credits: bigint;
	costMicros: bigint;
	input: MediaModelInput;
	catalogVersion?: string;
	pricingVersion?: string;
	enforceProspectiveDailyBudget?: boolean;
}

interface GenerationAuthorizationDependencies {
	enforceRateLimit(userId: string, action: string): Promise<void>;
	isEnvironmentGenerationEnabled?(): boolean;
	loadAccess(input: GenerationAuthorizationInput): Promise<GenerationAccessSnapshot>;
}

const productionDependencies: GenerationAuthorizationDependencies = {
	enforceRateLimit: enforceMediaRateLimit,
	async loadAccess(input) {
		const startOfDay = new Date();
		startOfDay.setUTCHours(0, 0, 0, 0);
		const sourceAssetId = "sourceAssetId" in input.input ? input.input.sourceAssetId : undefined;
		const [blocked, modelDisabled, account, dailyCost, subscription, sourceAsset] =
			await Promise.all([
				db.runtimeConfigOverride.findFirst({
					where: { active: true, configKey: "media.generation.enabled", value: { equals: false } },
				}),
				db.runtimeConfigOverride.findFirst({
					where: {
						active: true,
						configKey: `media.model.${input.productKey}.enabled`,
						value: { equals: false },
					},
				}),
				db.creditAccount.findUnique({
					where: { ownerType_ownerId: { ownerType: "USER", ownerId: input.userId } },
				}),
				db.generationQuote.aggregate({
					where: {
						ownerType: "USER",
						ownerId: input.userId,
						job: { isNot: null },
						createdAt: { gte: startOfDay },
					},
					_sum: { costMicros: true },
				}),
				db.subscription.findFirst({
					where: { ownerType: "USER", ownerId: input.userId, status: "ACTIVE" },
					include: { plan: true },
					orderBy: { updatedAt: "desc" },
				}),
				sourceAssetId
					? db.mediaAsset.findFirst({
							where: {
								id: sourceAssetId,
								ownerType: "USER",
								ownerId: input.userId,
								status: "READY",
								deletedAt: null,
							},
						})
					: Promise.resolve({ id: "not-required" }),
			]);
		const planId = resolvePlanId(subscription?.plan.metadata, subscription?.plan.name) ?? "free";
		return {
			generationEnabled: !blocked,
			modelEnabled: isCatalogModelEnabled(input.productKey, Boolean(modelDisabled)),
			spendableCredits: account?.spendableCredits ?? 0n,
			dailyCostMicros: dailyCost._sum.costMicros ?? 0n,
			planId,
			sourceAssetReady: Boolean(sourceAsset),
		};
	},
};

export async function assertGenerationAllowed(
	input: GenerationAuthorizationInput,
	dependencies: GenerationAuthorizationDependencies = productionDependencies,
): Promise<void> {
	const generationEnabled =
		dependencies.isEnvironmentGenerationEnabled?.() ??
		process.env.MEDIA_GENERATION_ENABLED === "true";
	if (!generationEnabled) {
		throw new Error("MODEL_DISABLED");
	}
	await dependencies.enforceRateLimit(input.userId, "media:generation");
	if (
		(input.catalogVersion && input.catalogVersion !== DEFAULT_PRODUCT_CONFIG.catalogVersion) ||
		(input.pricingVersion && input.pricingVersion !== DEFAULT_PRODUCT_CONFIG.pricingVersion)
	) {
		throw new Error("PRICE_CHANGED");
	}
	const access = await dependencies.loadAccess(input);
	if (!access.generationEnabled || !access.modelEnabled) throw new Error("MODEL_DISABLED");
	const entitlement = PLAN_ENTITLEMENTS.find((plan) => plan.id === access.planId);
	if (!entitlement?.allowedProducts.includes(input.productKey)) {
		throw new Error("ENTITLEMENT_REQUIRED");
	}
	if (!access.sourceAssetReady) throw new Error("ASSET_NOT_READY");
	if (access.spendableCredits < input.credits) throw new Error("INSUFFICIENT_CREDITS");
	if (
		input.costMicros > BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros) ||
		((input.enforceProspectiveDailyBudget ?? true) &&
			access.dailyCostMicros + input.costMicros >
				BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumDailyUserCostMicros))
	) {
		throw new Error("BUDGET_EXCEEDED");
	}
}

export function isCatalogModelEnabled(
	productKey: ProductModelKey,
	modelDisabled: boolean,
): boolean {
	return !modelDisabled && getCatalogEntry(productKey).routes.length > 0;
}

function resolvePlanId(metadata: unknown, planName: string | undefined): PlanId | null {
	const metadataPlanId =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>).planId
			: undefined;
	for (const value of [metadataPlanId, planName?.trim().toLowerCase()]) {
		if (value === "free" || value === "creator" || value === "studio") return value;
	}
	return null;
}
