import {
	createExecutableRouteGraph,
	executableRouteGraphOptionsFromEnvironment,
	type ExecutableRouteGraphOptions,
	type MediaModelInput,
} from "@repo/ai";
import {
	DEFAULT_PRODUCT_CONFIG,
	PLAN_ENTITLEMENTS,
	type PlanId,
	type ProductModelKey,
} from "@repo/config";
import { mediaDailyProviderCostBudgetMicros } from "@repo/config/server";
import { db } from "@repo/database/client";

import { ensureFreePlanCreditsForUser } from "./free-plan-credits";
import { loadUserPlanEntitlement } from "./plan-entitlement";
import { enforceMediaRateLimit } from "./rate-limit";
import { maximumMediaStorageBytes } from "./storage-limits";

export interface GenerationAccessSnapshot {
	generationEnabled: boolean;
	modelDisabled: boolean;
	spendableCredits: bigint;
	creditDebt: bigint;
	dailyCostMicros: bigint;
	globalDailyCostMicros?: bigint;
	maximumGlobalDailyCostMicros?: bigint;
	storageUsageBytes: bigint;
	maximumStorageBytes: bigint;
	planId: PlanId;
	sourceAssetReady: boolean;
	sourceAssetBytes: bigint | null;
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
	routeGraphOptions?: ExecutableRouteGraphOptions;
}

interface GenerationAuthorizationDependencies {
	enforceRateLimit(userId: string, action: string): Promise<void>;
	isEnvironmentGenerationEnabled?(): boolean;
	ensureFreeCredits?(userId: string): Promise<unknown>;
	loadAccess(input: GenerationAuthorizationInput): Promise<GenerationAccessSnapshot>;
}

const productionDependencies: GenerationAuthorizationDependencies = {
	enforceRateLimit: enforceMediaRateLimit,
	ensureFreeCredits: ensureFreePlanCreditsForUser,
	async loadAccess(input) {
		const startOfDay = new Date();
		startOfDay.setUTCHours(0, 0, 0, 0);
		const sourceAssetId = "sourceAssetId" in input.input ? input.input.sourceAssetId : undefined;
		const maximumGlobalDailyCostMicros = mediaDailyProviderCostBudgetMicros(process.env);
		const [
			blocked,
			modelDisabled,
			account,
			spendableLots,
			dailyCost,
			globalDailyCost,
			storageUsage,
			entitlement,
			sourceAsset,
		] = await Promise.all([
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
			db.creditLot.aggregate({
				where: {
					account: { ownerType: "USER", ownerId: input.userId },
					remainingAmount: { gt: 0n },
					OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
				},
				_sum: { remainingAmount: true },
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
			db.generationQuote.aggregate({
				where: {
					job: { isNot: null },
					createdAt: { gte: startOfDay },
				},
				_sum: { costMicros: true },
			}),
			db.storageUsageReservation.aggregate({
				where: {
					ownerType: "USER",
					ownerId: input.userId,
					status: { in: ["ACTIVE", "COMMITTED"] },
				},
				_sum: { bytes: true },
			}),
			loadUserPlanEntitlement(input.userId),
			sourceAssetId
				? db.mediaAsset.findFirst({
						where: {
							id: sourceAssetId,
							ownerType: "USER",
							ownerId: input.userId,
							status: "READY",
							deletedAt: null,
						},
						select: { mimeType: true, byteSize: true },
					})
				: Promise.resolve(null),
		]);
		return {
			generationEnabled: !blocked,
			modelDisabled: Boolean(modelDisabled),
			spendableCredits: spendableLots._sum.remainingAmount ?? 0n,
			creditDebt: account?.creditDebt ?? 0n,
			dailyCostMicros: dailyCost._sum.costMicros ?? 0n,
			globalDailyCostMicros: globalDailyCost._sum.costMicros ?? 0n,
			...(maximumGlobalDailyCostMicros === undefined ? {} : { maximumGlobalDailyCostMicros }),
			storageUsageBytes: storageUsage._sum.bytes ?? 0n,
			maximumStorageBytes: maximumMediaStorageBytes(),
			planId: entitlement.id,
			sourceAssetReady: isUsableGenerationSourceAsset(input.input, sourceAsset),
			sourceAssetBytes: sourceAsset?.byteSize ?? null,
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
	await dependencies.ensureFreeCredits?.(input.userId);
	const access = await dependencies.loadAccess(input);
	if (
		!access.generationEnabled ||
		access.modelDisabled ||
		!isCatalogModelEnabled(input.productKey, false, input.routeGraphOptions)
	) {
		throw new Error("MODEL_DISABLED");
	}
	const entitlement = PLAN_ENTITLEMENTS.find((plan) => plan.id === access.planId);
	if (!entitlement?.allowedProducts.includes(input.productKey)) {
		throw new Error("ENTITLEMENT_REQUIRED");
	}
	if (!access.sourceAssetReady) throw new Error("ASSET_NOT_READY");
	if (
		"sourceAssetId" in input.input &&
		(access.sourceAssetBytes === null ||
			access.sourceAssetBytes > BigInt(entitlement.maximumInputBytes))
	) {
		throw new Error("INPUT_TOO_LARGE");
	}
	if (access.creditDebt > 0n) throw new Error("CREDIT_DEBT_OUTSTANDING");
	if (access.spendableCredits < input.credits) throw new Error("INSUFFICIENT_CREDITS");
	if (access.storageUsageBytes >= access.maximumStorageBytes) {
		throw new Error("STORAGE_QUOTA_EXCEEDED");
	}
	if (
		input.costMicros > BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros) ||
		((input.enforceProspectiveDailyBudget ?? true) &&
			(access.dailyCostMicros + input.costMicros >
				BigInt(DEFAULT_PRODUCT_CONFIG.budgets.maximumDailyUserCostMicros) ||
				(access.maximumGlobalDailyCostMicros !== undefined &&
					(access.globalDailyCostMicros ?? 0n) + input.costMicros >
						access.maximumGlobalDailyCostMicros)))
	) {
		throw new Error("BUDGET_EXCEEDED");
	}
}

export function isCatalogModelEnabled(
	productKey: ProductModelKey,
	modelDisabled: boolean,
	routeGraphOptions: ExecutableRouteGraphOptions = executableRouteGraphOptionsFromEnvironment(),
): boolean {
	return (
		!modelDisabled && Boolean(createExecutableRouteGraph(routeGraphOptions).getEntry(productKey))
	);
}

export function isUsableGenerationSourceAsset(
	input: MediaModelInput,
	asset: { mimeType: string } | null,
): boolean {
	if (!("sourceAssetId" in input)) return true;
	return asset?.mimeType.startsWith("image/") ?? false;
}
