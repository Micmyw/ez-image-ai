import {
	createExecutableRouteGraph,
	executableRouteGraphOptionsFromEnvironment,
	type ExecutableRouteGraphOptions,
	type MediaModelInput,
} from "@repo/ai";
import {
	DEFAULT_PRODUCT_CONFIG,
	assertTemporaryReferenceUsable,
	type TemporaryReference,
	getImageProductSelectionContract,
	PLAN_ENTITLEMENTS,
	type PlanId,
	type ProductModelKey,
} from "@repo/config";
import { mediaDailyProviderCostBudgetMicros } from "@repo/config/server";
import { unexpiredStorageReservations } from "@repo/database";
import { db } from "@repo/database/client";
import {
	assertImagePassAvailable,
	assertImagePassSelection,
	generationFundingSource,
	type GenerationFundingSource,
} from "@repo/database/media-image-passes";

import { ensureFreePlanCreditsForGeneration } from "./free-plan-credits";
import { loadUserPlanAccess } from "./plan-entitlement";
import { enforceMediaRateLimit } from "./rate-limit";
import { maximumMediaStorageBytes } from "./storage-limits";

const rateLimitReceiptBrand: unique symbol = Symbol("generation-rate-limit-receipt");
export interface GenerationRateLimitReceipt {
	readonly [rateLimitReceiptBrand]: true;
}
const rateLimitReceiptOwners = new WeakMap<GenerationRateLimitReceipt, string>();

/** Issued only after this incoming request passes the real flood guard. Never serialized. */
export async function createGenerationRateLimitReceipt(
	userId: string,
	enforceRateLimit: typeof enforceMediaRateLimit = enforceMediaRateLimit,
): Promise<GenerationRateLimitReceipt> {
	await enforceRateLimit(userId, "media:generation");
	const receipt = Object.freeze({ [rateLimitReceiptBrand]: true as const });
	rateLimitReceiptOwners.set(receipt, userId);
	return receipt;
}

export interface GenerationAccessSnapshot {
	imagePassAvailable?: boolean;
	generationEnabled: boolean;
	modelDisabled: boolean;
	spendableCredits: bigint;
	creditDebt: bigint;
	dailyCostMicros: bigint;
	globalDailyCostMicros?: bigint;
	maximumGlobalDailyCostMicros?: bigint;
	storageUsageBytes: bigint;
	maximumStorageBytes: bigint | null;
	planId: PlanId;
	sourceAssetReady: boolean;
	sourceAssetBytes: bigint | null;
}

export interface GenerationAuthorizationInput {
	fundingSource?: GenerationFundingSource;
	/** Server-selected HTTP flood bucket; never a customer credit or trial counter. */
	rateLimitAction?: "media:quote" | "media:generation";
	/** Request-local capability; a client object or another owner cannot satisfy it. */
	rateLimitReceipt?: GenerationRateLimitReceipt;
	/** Server-verified receipt; never populated from unvalidated request metadata. */
	temporaryReference?: TemporaryReference;
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
	ensureFreeCredits: ensureFreePlanCreditsForGeneration,
	async loadAccess(input) {
		const now = new Date();
		const startOfDay = new Date(now);
		startOfDay.setUTCHours(0, 0, 0, 0);
		const sourceAssetId = "sourceAssetId" in input.input ? input.input.sourceAssetId : undefined;
		if (input.temporaryReference)
			assertTemporaryReferenceUsable(input.temporaryReference, input.userId, sourceAssetId ?? "");
		const maximumGlobalDailyCostMicros = mediaDailyProviderCostBudgetMicros(process.env);
		const [
			blocked,
			modelDisabled,
			account,
			spendableLots,
			dailyCost,
			globalDailyCost,
			storageUsage,
			planAccess,
			sourceAsset,
		] = await Promise.all([
			// The request's route graph already includes these runtime overrides.
			input.routeGraphOptions
				? Promise.resolve(
						input.routeGraphOptions.generationEnabled === false ? { blocked: true } : null,
					)
				: db.runtimeConfigOverride.findFirst({
						where: {
							active: true,
							configKey: "media.generation.enabled",
							value: { equals: false },
						},
					}),
			input.routeGraphOptions
				? Promise.resolve(
						input.routeGraphOptions.disabledProductKeys?.has(input.productKey)
							? { blocked: true }
							: null,
					)
				: db.runtimeConfigOverride.findFirst({
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
					OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
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
			maximumGlobalDailyCostMicros === undefined
				? Promise.resolve(undefined)
				: db.generationQuote.aggregate({
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
					...unexpiredStorageReservations(now),
				},
				_sum: { bytes: true },
			}),
			loadUserPlanAccess(input.userId, { now }),
			input.temporaryReference
				? Promise.resolve({
						mimeType: input.temporaryReference.contentType,
						byteSize: BigInt(input.temporaryReference.bytes),
					})
				: sourceAssetId
					? db.mediaAsset.findFirst({
							where: {
								id: sourceAssetId,
								ownerType: "USER",
								ownerId: input.userId,
								status: "READY",
								deletedAt: null,
								OR: [{ deleteAfter: null }, { deleteAfter: { gt: now } }],
							},
							select: { mimeType: true, byteSize: true },
						})
					: Promise.resolve(null),
		]);
		return {
			...(input.fundingSource === "IMAGE_PASS"
				? {
						imagePassAvailable: await assertImagePassAvailable(
							{
								ownerId: input.userId,
								productKey: input.productKey,
								skuKey: "skuKey" in input.input ? input.input.skuKey : undefined,
								requestedOutputCount: 1,
							},
							db,
						).then(() => true),
					}
				: {}),
			generationEnabled: !blocked,
			modelDisabled: Boolean(modelDisabled),
			spendableCredits: spendableLots._sum.remainingAmount ?? 0n,
			creditDebt: account?.creditDebt ?? 0n,
			dailyCostMicros: dailyCost._sum.costMicros ?? 0n,
			globalDailyCostMicros: globalDailyCost?._sum.costMicros ?? 0n,
			...(maximumGlobalDailyCostMicros === undefined ? {} : { maximumGlobalDailyCostMicros }),
			storageUsageBytes: storageUsage._sum.bytes ?? 0n,
			maximumStorageBytes: planAccess.hasEffectivePaidSubscription
				? null
				: maximumMediaStorageBytes(),
			planId: planAccess.entitlement.id,
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
	const fundingSource = generationFundingSource({ fundingSource: input.fundingSource });
	if (fundingSource === "IMAGE_PASS")
		assertImagePassSelection({
			productKey: input.productKey,
			skuKey: "skuKey" in input.input ? input.input.skuKey : undefined,
			requestedOutputCount: 1,
		});
	if (input.rateLimitReceipt !== undefined) {
		if (
			rateLimitReceiptOwners.get(input.rateLimitReceipt) !== input.userId ||
			(input.rateLimitAction !== undefined && input.rateLimitAction !== "media:generation")
		)
			throw new Error("NOT_FOUND");
	} else {
		await dependencies.enforceRateLimit(input.userId, input.rateLimitAction ?? "media:generation");
	}
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
	if (fundingSource === "IMAGE_PASS" && !access.imagePassAvailable)
		throw new Error("IMAGE_PASS_INSUFFICIENT");
	if (
		!entitlement ||
		(fundingSource === "CREDITS" && !entitlement.allowedProducts.includes(input.productKey))
	) {
		throw new Error("ENTITLEMENT_REQUIRED");
	}
	if (!access.sourceAssetReady) throw new Error("ASSET_NOT_READY");
	const maximumInputBytes = Math.min(
		entitlement.maximumInputBytes,
		getImageProductSelectionContract(input.productKey)?.maximumInputBytes ??
			entitlement.maximumInputBytes,
	);
	if (
		"sourceAssetId" in input.input &&
		(access.sourceAssetBytes === null || access.sourceAssetBytes > BigInt(maximumInputBytes))
	) {
		throw new Error("INPUT_TOO_LARGE");
	}
	if (access.creditDebt > 0n) throw new Error("CREDIT_DEBT_OUTSTANDING");
	if (fundingSource === "CREDITS" && access.spendableCredits < input.credits)
		throw new Error("INSUFFICIENT_CREDITS");
	if (
		access.maximumStorageBytes !== null &&
		access.storageUsageBytes >= access.maximumStorageBytes
	) {
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
