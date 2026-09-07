import {
	KieProviderAdapter,
	type MediaProviderAdapter,
	type ProviderExecutionInput,
} from "@repo/ai";

type SmokeProductKey =
	| "image-nano-banana-2-lite"
	| "image-nano-banana"
	| "image-nano-banana-2"
	| "image-nano-banana-pro"
	| "image-gpt-image-1-5"
	| "image-gpt-image-2"
	| "image-seedream-4-5"
	| "image-seedream-5-lite"
	| "image-seedream-5-pro";
type SmokeProvider = "kie";

export interface SmokeRoute {
	provider: SmokeProvider;
	model: string;
	productKey: SmokeProductKey;
	skuKey: string;
	expectedCostMicros: number;
	inputKind: "image-to-image" | "text-to-video";
	requiresCancellation: boolean;
}

export interface ProviderSmokeConfiguration {
	routes: SmokeRoute[];
	expectedCostMicros: number;
	prompt: string;
	confirmLive: boolean;
}

type ProviderSmokeEnvironment = Record<string, string | undefined>;

export interface ProviderSmokeDependencies {
	createAdapter(
		provider: SmokeProvider,
		environment: ProviderSmokeEnvironment,
	): MediaProviderAdapter;
}

const ROUTES: Record<string, SmokeRoute> = {
	"image-nano-banana-2-lite:nano-banana-2-lite-1k:kie": {
		provider: "kie",
		model: "nano-banana-2-lite",
		productKey: "image-nano-banana-2-lite",
		skuKey: "nano-banana-2-lite-1k",
		expectedCostMicros: 20_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-nano-banana:nano-banana-default:kie": {
		provider: "kie",
		model: "google/nano-banana-edit",
		productKey: "image-nano-banana",
		skuKey: "nano-banana-default",
		expectedCostMicros: 20_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-nano-banana-2:nano-banana-2-1k:kie": {
		provider: "kie",
		model: "nano-banana-2",
		productKey: "image-nano-banana-2",
		skuKey: "nano-banana-2-1k",
		expectedCostMicros: 40_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-nano-banana-2:nano-banana-2-2k:kie": {
		provider: "kie",
		model: "nano-banana-2",
		productKey: "image-nano-banana-2",
		skuKey: "nano-banana-2-2k",
		expectedCostMicros: 60_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-nano-banana-2:nano-banana-2-4k:kie": {
		provider: "kie",
		model: "nano-banana-2",
		productKey: "image-nano-banana-2",
		skuKey: "nano-banana-2-4k",
		expectedCostMicros: 90_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-nano-banana-pro:nano-banana-pro-1k:kie": {
		provider: "kie",
		model: "nano-banana-pro",
		productKey: "image-nano-banana-pro",
		skuKey: "nano-banana-pro-1k",
		expectedCostMicros: 90_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-nano-banana-pro:nano-banana-pro-2k:kie": {
		provider: "kie",
		model: "nano-banana-pro",
		productKey: "image-nano-banana-pro",
		skuKey: "nano-banana-pro-2k",
		expectedCostMicros: 90_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-nano-banana-pro:nano-banana-pro-4k:kie": {
		provider: "kie",
		model: "nano-banana-pro",
		productKey: "image-nano-banana-pro",
		skuKey: "nano-banana-pro-4k",
		expectedCostMicros: 120_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-gpt-image-1-5:gpt-image-1-5-medium:kie": {
		provider: "kie",
		model: "gpt-image/1.5-image-to-image",
		productKey: "image-gpt-image-1-5",
		skuKey: "gpt-image-1-5-medium",
		expectedCostMicros: 20_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-gpt-image-1-5:gpt-image-1-5-high:kie": {
		provider: "kie",
		model: "gpt-image/1.5-image-to-image",
		productKey: "image-gpt-image-1-5",
		skuKey: "gpt-image-1-5-high",
		expectedCostMicros: 110_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-gpt-image-2:gpt-image-2-1k:kie": {
		provider: "kie",
		model: "gpt-image-2-image-to-image",
		productKey: "image-gpt-image-2",
		skuKey: "gpt-image-2-1k",
		expectedCostMicros: 30_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-gpt-image-2:gpt-image-2-2k:kie": {
		provider: "kie",
		model: "gpt-image-2-image-to-image",
		productKey: "image-gpt-image-2",
		skuKey: "gpt-image-2-2k",
		expectedCostMicros: 50_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-gpt-image-2:gpt-image-2-4k:kie": {
		provider: "kie",
		model: "gpt-image-2-image-to-image",
		productKey: "image-gpt-image-2",
		skuKey: "gpt-image-2-4k",
		expectedCostMicros: 80_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-seedream-4-5:seedream-4-5-basic-2k:kie": {
		provider: "kie",
		model: "seedream/4.5-edit",
		productKey: "image-seedream-4-5",
		skuKey: "seedream-4-5-basic-2k",
		expectedCostMicros: 32_500,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-seedream-4-5:seedream-4-5-high-4k:kie": {
		provider: "kie",
		model: "seedream/4.5-edit",
		productKey: "image-seedream-4-5",
		skuKey: "seedream-4-5-high-4k",
		expectedCostMicros: 32_500,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-seedream-5-lite:seedream-5-lite-basic-2k:kie": {
		provider: "kie",
		model: "seedream/5-lite-image-to-image",
		productKey: "image-seedream-5-lite",
		skuKey: "seedream-5-lite-basic-2k",
		expectedCostMicros: 27_500,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-seedream-5-lite:seedream-5-lite-high-3k:kie": {
		provider: "kie",
		model: "seedream/5-lite-image-to-image",
		productKey: "image-seedream-5-lite",
		skuKey: "seedream-5-lite-high-3k",
		expectedCostMicros: 27_500,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-seedream-5-lite:seedream-5-lite-ultra-4k:kie": {
		provider: "kie",
		model: "seedream/5-lite-image-to-image",
		productKey: "image-seedream-5-lite",
		skuKey: "seedream-5-lite-ultra-4k",
		expectedCostMicros: 27_500,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-seedream-5-pro:seedream-5-pro-basic-1k:kie": {
		provider: "kie",
		model: "seedream/5-pro-image-to-image",
		productKey: "image-seedream-5-pro",
		skuKey: "seedream-5-pro-basic-1k",
		expectedCostMicros: 35_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-seedream-5-pro:seedream-5-pro-high-2k:kie": {
		provider: "kie",
		model: "seedream/5-pro-image-to-image",
		productKey: "image-seedream-5-pro",
		skuKey: "seedream-5-pro-high-2k",
		expectedCostMicros: 70_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
};

export function parseProviderSmokeConfiguration(
	environment: ProviderSmokeEnvironment,
): ProviderSmokeConfiguration {
	const allowlist = requiredCsv(environment, "PROVIDER_SMOKE_ALLOWLIST");
	const enabledSkus = requiredCsv(environment, "PROVIDER_SMOKE_ENABLED_SKUS");
	const maxInvocations = requiredPositiveInteger(environment, "PROVIDER_SMOKE_MAX_INVOCATIONS");
	const maxExpectedCostMicros = requiredPositiveInteger(
		environment,
		"PROVIDER_SMOKE_MAX_EXPECTED_COST_MICROS",
	);
	const prompt = requiredValue(environment, "PROVIDER_SMOKE_PROMPT");
	if (allowlist.length > maxInvocations) {
		throw new Error("Provider smoke allowlist exceeds PROVIDER_SMOKE_MAX_INVOCATIONS");
	}
	const routes = allowlist.map((key) => {
		const route = ROUTES[key];
		if (!route) throw new Error(`Provider smoke route is not configured: ${key}`);
		return route;
	});
	for (const skuKey of enabledSkus) {
		const matches = routes.filter((route) => route.skuKey === skuKey);
		if (matches.length !== 1) {
			throw new Error(`Enabled SKU ${skuKey} must have exactly one configured smoke route`);
		}
	}
	for (const route of routes) {
		if (!enabledSkus.includes(route.skuKey)) {
			throw new Error(`Allowlisted route SKU is not enabled: ${route.skuKey}`);
		}
	}
	const expectedCostMicros = routes.reduce((sum, route) => sum + route.expectedCostMicros, 0);
	if (expectedCostMicros > maxExpectedCostMicros) {
		throw new Error(
			`Expected cost ${expectedCostMicros} exceeds PROVIDER_SMOKE_MAX_EXPECTED_COST_MICROS=${maxExpectedCostMicros}`,
		);
	}

	const confirmLive = environment.PROVIDER_SMOKE_CONFIRM_LIVE?.trim() === "true";
	return { routes, expectedCostMicros, prompt, confirmLive };
}

export function createProviderSmokeInput(
	route: SmokeRoute,
	configuration: ProviderSmokeConfiguration,
): ProviderExecutionInput {
	if (route.inputKind === "text-to-video") {
		return { kind: "text-to-video", prompt: configuration.prompt, durationSeconds: 1 };
	}
	throw new Error(
		"NOT_COMPLETED: direct image Provider input is disabled; use the private generation and finalization pipeline",
	);
}

export async function runProviderSmoke(
	configuration: ProviderSmokeConfiguration,
	environment: ProviderSmokeEnvironment = process.env,
	dependencies: ProviderSmokeDependencies = defaultDependencies,
): Promise<void> {
	console.log(
		`Budget gate passed for ${configuration.routes.length} invocation(s), maximum expected cost ${configuration.expectedCostMicros} micros`,
	);
	if (!configuration.confirmLive) {
		console.log("Dry run only. Set PROVIDER_SMOKE_CONFIRM_LIVE=true to call providers.");
		return;
	}
	if (configuration.routes.some((route) => route.inputKind === "image-to-image")) {
		throw new Error(
			"NOT_COMPLETED: live image smoke must use the private generation and finalization pipeline",
		);
	}
	const executions = configuration.routes.map((route) => ({
		route,
		adapter: dependencies.createAdapter(route.provider, environment),
	}));
	for (const { route, adapter } of executions) {
		if (route.requiresCancellation && !adapter.cancel) {
			throw new Error(
				`Live smoke for ${route.productKey}/${route.skuKey}:${route.provider} is disabled until automatic provider cleanup is implemented`,
			);
		}
	}
	const cleanupTasks: Array<() => Promise<void>> = [];
	let executionError: unknown;
	try {
		for (const [index, execution] of executions.entries()) {
			const { route, adapter } = execution;
			const attemptId = `smoke-${Date.now()}-${index}`;
			const submission = await adapter.submit({
				attemptId,
				providerModelId: route.model,
				input: createProviderSmokeInput(route, configuration),
			});
			if (submission.outcome !== "accepted") {
				const detail =
					submission.outcome === "rejected"
						? submission.failure.code
						: submission.uncertainty.classification;
				throw new Error(`${route.provider}/${route.model} did not accept smoke: ${detail}`);
			}
			if (!route.requiresCancellation && submission.status !== "SUCCEEDED") {
				throw new Error(
					`${route.provider}/${route.model} did not complete synchronous smoke: ${submission.status}`,
				);
			}
			if (route.requiresCancellation && submission.providerTaskId && adapter.cancel) {
				const providerTaskId = submission.providerTaskId;
				cleanupTasks.push(async () => {
					const canceled = await adapter.cancel!({
						providerTaskId,
						idempotencyKey: `provider-smoke-cancel:${attemptId}`,
					});
					if (!canceled.canceled && canceled.status !== "CANCELED") {
						throw new Error(`Cleanup could not confirm cancellation for ${providerTaskId}`);
					}
				});
			}
			console.log(
				`${route.productKey}/${route.skuKey}:${route.provider} accepted with status ${submission.status} and task ${submission.providerTaskId ?? "synchronous"}`,
			);
		}
	} catch (error) {
		executionError = error;
	}
	const cleanupResults = await Promise.allSettled(cleanupTasks.map((cleanup) => cleanup()));
	const cleanupFailures = cleanupResults.filter((result) => result.status === "rejected");
	if (executionError && cleanupFailures.length > 0) {
		throw new AggregateError(
			[executionError, ...cleanupFailures],
			"Provider smoke and cleanup failed",
		);
	}
	if (executionError) throw executionError;
	if (cleanupFailures.length > 0) {
		throw new AggregateError(cleanupFailures, "Provider smoke cleanup failed");
	}
}

function createAdapter(
	provider: SmokeProvider,
	environment: ProviderSmokeEnvironment,
): MediaProviderAdapter {
	switch (provider) {
		case "kie":
			return new KieProviderAdapter({ apiKey: requiredValue(environment, "KIE_API_KEY") });
	}
}

const defaultDependencies: ProviderSmokeDependencies = { createAdapter };

function requiredValue(environment: ProviderSmokeEnvironment, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required before any provider call`);
	return value;
}

function requiredCsv(environment: ProviderSmokeEnvironment, name: string): string[] {
	const value = requiredValue(environment, name);
	const values = [
		...new Set(
			value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
	if (values.length === 0) throw new Error(`${name} cannot be empty`);
	return values;
}

function requiredPositiveInteger(environment: ProviderSmokeEnvironment, name: string): number {
	const value = Number(environment[name]);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer before any provider call`);
	}
	return value;
}

async function main(): Promise<void> {
	await runProviderSmoke(parseProviderSmokeConfiguration(process.env));
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/tests/load/provider-smoke.ts")) {
	void main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
