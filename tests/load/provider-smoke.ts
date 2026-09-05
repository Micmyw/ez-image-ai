import {
	FalProviderAdapter,
	KieProviderAdapter,
	type MediaProviderAdapter,
	type ProviderExecutionInput,
} from "@repo/ai";

type SmokeTier = "image-fast" | "image-quality" | "video-fast" | "video-quality";
type SmokeProvider = "openrouter" | "fal" | "kie";

export interface SmokeRoute {
	provider: SmokeProvider;
	model: string;
	tier: SmokeTier;
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
	"image-fast:openrouter": {
		provider: "openrouter",
		model: "sourceful/riverflow-v2.5-fast",
		tier: "image-fast",
		expectedCostMicros: 23_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"image-quality:openrouter": {
		provider: "openrouter",
		model: "sourceful/riverflow-v2.5-pro",
		tier: "image-quality",
		expectedCostMicros: 180_000,
		inputKind: "image-to-image",
		requiresCancellation: false,
	},
	"video-fast:fal": {
		provider: "fal",
		model: "fal-ai/fast-video",
		tier: "video-fast",
		expectedCostMicros: 100_000,
		inputKind: "text-to-video",
		requiresCancellation: true,
	},
	"video-quality:kie": {
		provider: "kie",
		model: "kie/video-quality",
		tier: "video-quality",
		expectedCostMicros: 300_000,
		inputKind: "text-to-video",
		requiresCancellation: true,
	},
};

export function parseProviderSmokeConfiguration(
	environment: ProviderSmokeEnvironment,
): ProviderSmokeConfiguration {
	const allowlist = requiredCsv(environment, "PROVIDER_SMOKE_ALLOWLIST");
	const enabledTiers = requiredCsv(environment, "PROVIDER_SMOKE_ENABLED_TIERS");
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
	for (const tier of enabledTiers) {
		const matches = routes.filter((route) => route.tier === tier);
		if (matches.length !== 1) {
			throw new Error(`Enabled tier ${tier} must have exactly one configured smoke route`);
		}
	}
	for (const route of routes) {
		if (!enabledTiers.includes(route.tier)) {
			throw new Error(`Allowlisted route tier is not enabled: ${route.tier}`);
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
				`Live smoke for ${route.tier}:${route.provider} is disabled until automatic provider cleanup is implemented`,
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
				`${route.tier}:${route.provider} accepted with status ${submission.status} and task ${submission.providerTaskId ?? "synchronous"}`,
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
		case "openrouter":
			throw new Error(
				"NOT_COMPLETED: direct OpenRouter image smoke is disabled; use the private generation and finalization pipeline",
			);
		case "fal":
			return new FalProviderAdapter({ apiKey: requiredValue(environment, "FAL_API_KEY") });
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
