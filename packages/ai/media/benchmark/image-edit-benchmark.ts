import { getCatalogEntry } from "../catalog/catalog";
import type { ProviderKey } from "../types";
import { buildImageEditBenchmarkScorecard, type ImageEditBenchmarkScorecard } from "./scorecard";
import {
	IMAGE_EDIT_BENCHMARK_CATEGORIES,
	IMAGE_EDIT_BENCHMARK_TASK_KINDS,
	parseImageEditBenchmarkManifest,
	parseImageEditBenchmarkObservation,
	type ImageEditBenchmarkCategory,
	type ImageEditBenchmarkManifest,
	type ImageEditBenchmarkResult,
	type ImageEditBenchmarkRoute,
	type ImageEditBenchmarkTaskKind,
} from "./types";

const DEFAULT_MANIFEST_PATH = "fixtures/image-edit-benchmark/manifest.json";
const IMAGE_EDIT_PRODUCT_KEYS = ["image-fast", "image-quality"] as const;

export interface ImageEditBenchmarkCliOptions {
	mode: "dry-run" | "live";
	confirmSpend: boolean;
	maxBudgetMicros?: number;
	manifestPath: string;
	routeSelectors?: string[];
}

export interface ImageEditBenchmarkPlan {
	imageCount: number;
	taskCount: number;
	routeCount: number;
	plannedInvocations: number;
	maximumCatalogCostMicros: number;
	costBasis: "UNCERTIFIED_CATALOG_ESTIMATE";
	routes: ImageEditBenchmarkRoute[];
	categories: Record<ImageEditBenchmarkCategory, number>;
	taskKinds: Record<ImageEditBenchmarkTaskKind, number>;
}

export interface ImageEditBenchmarkExecutionInput {
	caseId: string;
	route: ImageEditBenchmarkRoute;
	inputId: string;
	taskId: string;
	taskKind: ImageEditBenchmarkTaskKind;
	prompt: string;
	sourceAssetId: string;
}

/**
 * A live executor must use the existing production job/private-finalization path. It may not
 * return Provider URLs, signed URLs, raw payloads, prompts, or credentials.
 */
export type ImageEditBenchmarkExecutor = (
	input: ImageEditBenchmarkExecutionInput,
) => Promise<ImageEditBenchmarkResult>;

export interface ImageEditBenchmarkReport {
	status: "DRY_RUN_ONLY" | "EXECUTION_RECORDED_NOT_CERTIFIED";
	generatedAt: string;
	certification: {
		status: "NOT_COMPLETED";
		reason: string;
	};
	plan: ImageEditBenchmarkPlan;
	scorecard: ImageEditBenchmarkScorecard;
	routeDecisions: {
		standard: { status: "NOT_COMPLETED"; selectedRoute: null; reason: string };
		quality: { status: "NOT_COMPLETED"; selectedRoute: null; reason: string };
	};
	privacy: {
		sourceImages: "PRIVATE_NOT_INCLUDED";
		prompts: "PRIVATE_NOT_INCLUDED";
		outputs: "PRIVATE_NOT_INCLUDED";
		rawProviderPayloads: "PRIVATE_NOT_INCLUDED";
	};
}

export function parseImageEditBenchmarkCliArguments(
	args: readonly string[],
	environment: Record<string, string | undefined> = process.env,
): ImageEditBenchmarkCliOptions {
	let mode: ImageEditBenchmarkCliOptions["mode"] = "dry-run";
	let modeWasSet = false;
	let confirmSpend = false;
	let maxBudgetMicros: number | undefined;
	let manifestPath = environment.IMAGE_EDIT_BENCHMARK_MANIFEST?.trim() || DEFAULT_MANIFEST_PATH;
	let manifestWasSet = false;
	const routeSelectors: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (argument === "--live" || argument === "--dry-run") {
			if (modeWasSet) throw new Error("Benchmark mode may only be provided once");
			mode = argument === "--live" ? "live" : "dry-run";
			modeWasSet = true;
			continue;
		}
		if (argument === "--confirm-spend") {
			if (confirmSpend) throw new Error("--confirm-spend may only be provided once");
			confirmSpend = true;
			continue;
		}
		const budget = optionValue(args, index, argument, "--max-budget-micros");
		if (budget) {
			if (maxBudgetMicros !== undefined) {
				throw new Error("--max-budget-micros may only be provided once");
			}
			maxBudgetMicros = positiveInteger(budget.value, "--max-budget-micros");
			index += budget.consumedNext ? 1 : 0;
			continue;
		}
		const manifest = optionValue(args, index, argument, "--manifest");
		if (manifest) {
			if (manifestWasSet) throw new Error("--manifest may only be provided once");
			manifestPath = manifest.value.trim();
			if (!manifestPath) throw new Error("--manifest cannot be empty");
			manifestWasSet = true;
			index += manifest.consumedNext ? 1 : 0;
			continue;
		}
		const route = optionValue(args, index, argument, "--route");
		if (route) {
			const selector = route.value.trim();
			if (!selector) throw new Error("--route cannot be empty");
			routeSelectors.push(selector);
			index += route.consumedNext ? 1 : 0;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}

	return {
		mode,
		confirmSpend,
		...(maxBudgetMicros === undefined ? {} : { maxBudgetMicros }),
		manifestPath,
		...(routeSelectors.length === 0 ? {} : { routeSelectors }),
	};
}

export function resolveImageEditBenchmarkRoutes(
	routeSelectors?: readonly string[],
): ImageEditBenchmarkRoute[] {
	const catalogRoutes = IMAGE_EDIT_PRODUCT_KEYS.flatMap((productKey) => {
		const entry = getCatalogEntry(productKey);
		if (
			entry.mediaKind !== "image" ||
			entry.inputKinds.length !== 1 ||
			entry.inputKinds[0] !== "image-to-image"
		) {
			throw new Error(`${productKey} is not an image-to-image-only catalog product`);
		}
		return entry.routes.map((route) => {
			if (!Number.isSafeInteger(route.providerCostMicros) || route.providerCostMicros <= 0) {
				throw new Error(`Catalog route cost is not a positive safe integer for ${productKey}`);
			}
			return {
				productKey,
				provider: route.provider,
				providerModelId: route.providerModelId,
				catalogCostMicros: route.providerCostMicros,
			} satisfies ImageEditBenchmarkRoute;
		});
	});
	if (!routeSelectors || routeSelectors.length === 0) return catalogRoutes;

	const routesByRef = new Map(
		catalogRoutes.map((route) => [imageEditBenchmarkRouteRef(route), route]),
	);
	const selected: ImageEditBenchmarkRoute[] = [];
	const seen = new Set<string>();
	for (const selector of routeSelectors) {
		const route = routesByRef.get(selector);
		if (!route) {
			throw new Error(`Route ${selector} is not a current image-edit catalog route`);
		}
		if (!seen.has(selector)) {
			selected.push(route);
			seen.add(selector);
		}
	}
	return selected;
}

export function imageEditBenchmarkRouteRef(route: ImageEditBenchmarkRoute): string {
	return `${route.productKey}:${route.provider}:${route.providerModelId}`;
}

export function createImageEditBenchmarkPlan(
	manifestInput: ImageEditBenchmarkManifest,
	routeSelectors?: readonly string[],
): ImageEditBenchmarkPlan {
	const manifest = parseImageEditBenchmarkManifest(manifestInput);
	const routes = resolveImageEditBenchmarkRoutes(routeSelectors);
	const taskCount = manifest.images.reduce((sum, image) => sum + image.tasks.length, 0);
	const plannedInvocations = safeProduct(taskCount, routes.length, "planned invocation count");
	const perTaskCatalogCost = routes.reduce(
		(sum, route) => safeSum(sum, route.catalogCostMicros, "catalog cost ceiling"),
		0,
	);
	const maximumCatalogCostMicros = safeProduct(
		taskCount,
		perTaskCatalogCost,
		"catalog cost ceiling",
	);
	const categories = Object.fromEntries(
		IMAGE_EDIT_BENCHMARK_CATEGORIES.map((category) => [category, 0]),
	) as Record<ImageEditBenchmarkCategory, number>;
	const taskKinds = Object.fromEntries(
		IMAGE_EDIT_BENCHMARK_TASK_KINDS.map((kind) => [kind, 0]),
	) as Record<ImageEditBenchmarkTaskKind, number>;
	for (const image of manifest.images) {
		categories[image.category] += 1;
		for (const task of image.tasks) taskKinds[task.kind] += 1;
	}

	return {
		imageCount: manifest.images.length,
		taskCount,
		routeCount: routes.length,
		plannedInvocations,
		maximumCatalogCostMicros,
		costBasis: "UNCERTIFIED_CATALOG_ESTIMATE",
		routes,
		categories,
		taskKinds,
	};
}

export async function runImageEditBenchmark(
	options: {
		manifest: unknown;
		mode: "dry-run" | "live";
		confirmSpend?: boolean;
		maxBudgetMicros?: number;
		routeSelectors?: readonly string[];
	},
	dependencies: {
		executeCase?: ImageEditBenchmarkExecutor;
		environment?: Record<string, string | undefined>;
		now?: () => Date;
	} = {},
): Promise<ImageEditBenchmarkReport> {
	const manifest = parseImageEditBenchmarkManifest(options.manifest);
	const plan = createImageEditBenchmarkPlan(manifest, options.routeSelectors);
	const routePlans = plan.routes.map((route) => ({
		route,
		plannedInvocations: plan.taskCount,
	}));
	if (options.mode === "dry-run") {
		return createReport(
			"DRY_RUN_ONLY",
			plan,
			buildImageEditBenchmarkScorecard(routePlans, []),
			dependencies.now,
		);
	}

	if (options.confirmSpend !== true) {
		throw new Error("Live image-edit benchmark requires --confirm-spend before any Provider call");
	}
	if (!Number.isSafeInteger(options.maxBudgetMicros) || (options.maxBudgetMicros ?? 0) <= 0) {
		throw new Error(
			"Live image-edit benchmark requires a positive --max-budget-micros before any Provider call",
		);
	}
	const maxBudgetMicros = options.maxBudgetMicros!;
	if (plan.maximumCatalogCostMicros > maxBudgetMicros) {
		throw new Error(
			`Planned catalog cost ceiling ${plan.maximumCatalogCostMicros} exceeds explicit budget ${maxBudgetMicros} before any Provider call`,
		);
	}
	for (const image of manifest.images) assertAuthorizedPrivateInput(image);
	assertProviderCredentials(plan.routes, dependencies.environment ?? process.env);
	if (!dependencies.executeCase) {
		throw new Error(
			"Live image-edit benchmark requires a private production pipeline executor; direct Provider output handling is prohibited",
		);
	}

	const observations = [];
	let caseNumber = 0;
	let observedCostMicros = 0;
	let remainingCatalogCostMicros = plan.maximumCatalogCostMicros;
	for (const image of manifest.images) {
		const sourceAssetId = assertAuthorizedPrivateInput(image);
		for (const task of image.tasks) {
			for (const route of plan.routes) {
				const remainingCostCeiling = safeSum(
					observedCostMicros,
					remainingCatalogCostMicros,
					"remaining catalog cost ceiling",
				);
				if (remainingCostCeiling > maxBudgetMicros) {
					throw new Error(
						`Remaining catalog cost ceiling ${remainingCostCeiling} exceeds explicit budget ${maxBudgetMicros} before the next Provider call`,
					);
				}
				caseNumber += 1;
				const caseId = `case-${String(caseNumber).padStart(4, "0")}`;
				const result = await dependencies.executeCase({
					caseId,
					route,
					inputId: image.id,
					taskId: task.id,
					taskKind: task.kind,
					prompt: task.prompt,
					sourceAssetId,
				});
				remainingCatalogCostMicros -= route.catalogCostMicros;
				const observation = parseImageEditBenchmarkObservation({ caseId, route, ...result });
				observations.push(observation);
				if (observation.providerCostMicros === null) {
					throw new Error(
						"Observed Provider cost is unavailable after a Provider call; no further calls are allowed",
					);
				}
				observedCostMicros = safeSum(
					observedCostMicros,
					observation.providerCostMicros,
					"observed Provider cost",
				);
				if (observedCostMicros > maxBudgetMicros) {
					throw new Error(
						`Observed Provider cost ${observedCostMicros} exceeds explicit budget ${maxBudgetMicros}; no further calls are allowed`,
					);
				}
			}
		}
	}

	return createReport(
		"EXECUTION_RECORDED_NOT_CERTIFIED",
		plan,
		buildImageEditBenchmarkScorecard(routePlans, observations),
		dependencies.now,
	);
}

export function serializeImageEditBenchmarkReport(report: ImageEditBenchmarkReport): string {
	return JSON.stringify(report, null, 2);
}

function createReport(
	status: ImageEditBenchmarkReport["status"],
	plan: ImageEditBenchmarkPlan,
	scorecard: ImageEditBenchmarkScorecard,
	now: (() => Date) | undefined,
): ImageEditBenchmarkReport {
	const dryRun = status === "DRY_RUN_ONLY";
	const reason = dryRun
		? "Real Provider execution, private output review, and human scoring were not performed."
		: "Execution records do not certify routes; authorized human review and an explicit routing decision are still required.";
	return {
		status,
		generatedAt: (now?.() ?? new Date()).toISOString(),
		certification: { status: "NOT_COMPLETED", reason },
		plan,
		scorecard,
		routeDecisions: {
			standard: { status: "NOT_COMPLETED", selectedRoute: null, reason },
			quality: { status: "NOT_COMPLETED", selectedRoute: null, reason },
		},
		privacy: {
			sourceImages: "PRIVATE_NOT_INCLUDED",
			prompts: "PRIVATE_NOT_INCLUDED",
			outputs: "PRIVATE_NOT_INCLUDED",
			rawProviderPayloads: "PRIVATE_NOT_INCLUDED",
		},
	};
}

function assertAuthorizedPrivateInput(image: ImageEditBenchmarkManifest["images"][number]): string {
	if (image.authorization.status !== "authorized" || image.source.kind !== "private-asset") {
		throw new Error(
			`Benchmark input ${image.id} must reference an authorized private asset before any Provider call`,
		);
	}
	return image.source.assetId;
}

function assertProviderCredentials(
	routes: readonly ImageEditBenchmarkRoute[],
	environment: Record<string, string | undefined>,
): void {
	const checked = new Set<ProviderKey>();
	for (const route of routes) {
		if (checked.has(route.provider)) continue;
		checked.add(route.provider);
		const name = providerCredentialName(route.provider);
		if (!environment[name]?.trim()) {
			throw new Error(`${name} is required before any Provider call`);
		}
	}
}

function providerCredentialName(provider: ProviderKey): string {
	switch (provider) {
		case "replicate":
			return "REPLICATE_API_TOKEN";
		case "fal":
			return "FAL_API_KEY";
		case "kie":
			return "KIE_API_KEY";
		case "gemini":
			return "GEMINI_API_KEY";
	}
}

function optionValue(
	args: readonly string[],
	index: number,
	argument: string,
	name: string,
): { value: string; consumedNext: boolean } | null {
	if (argument === name) {
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`${name} requires a value`);
		}
		return { value, consumedNext: true };
	}
	if (argument.startsWith(`${name}=`)) {
		return { value: argument.slice(name.length + 1), consumedNext: false };
	}
	return null;
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function safeProduct(left: number, right: number, label: string): number {
	const value = left * right;
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} exceeds safe limits`);
	return value;
}

function safeSum(left: number, right: number, label: string): number {
	const value = left + right;
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} exceeds safe limits`);
	return value;
}
