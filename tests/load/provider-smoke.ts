import {
	FalProviderAdapter,
	GeminiProviderAdapter,
	KieProviderAdapter,
	ReplicateProviderAdapter,
	type MediaProviderAdapter,
	type ProviderExecutionInput,
} from "@repo/ai";

interface SmokeRoute {
	provider: "replicate" | "fal" | "kie" | "gemini";
	model: string;
	tier: "image-fast" | "image-quality" | "video-fast" | "video-quality";
	expectedCostMicros: number;
}

const ROUTES: Record<string, SmokeRoute> = {
	"image-fast:replicate": {
		provider: "replicate",
		model: "black-forest-labs/flux-schnell",
		tier: "image-fast",
		expectedCostMicros: 3_000,
	},
	"image-fast:fal": {
		provider: "fal",
		model: "fal-ai/flux/schnell",
		tier: "image-fast",
		expectedCostMicros: 3_500,
	},
	"image-quality:gemini": {
		provider: "gemini",
		model: "gemini-2.5-flash-image",
		tier: "image-quality",
		expectedCostMicros: 8_000,
	},
	"video-fast:fal": {
		provider: "fal",
		model: "fal-ai/fast-video",
		tier: "video-fast",
		expectedCostMicros: 100_000,
	},
	"video-quality:kie": {
		provider: "kie",
		model: "kie/video-quality",
		tier: "video-quality",
		expectedCostMicros: 300_000,
	},
};

const allowlist = requiredCsv("PROVIDER_SMOKE_ALLOWLIST");
const enabledTiers = requiredCsv("PROVIDER_SMOKE_ENABLED_TIERS");
const maxInvocations = requiredPositiveInteger("PROVIDER_SMOKE_MAX_INVOCATIONS");
const maxExpectedCostMicros = requiredPositiveInteger("PROVIDER_SMOKE_MAX_EXPECTED_COST_MICROS");
const prompt = requiredSecret("PROVIDER_SMOKE_PROMPT");
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
const expectedCost = routes.reduce((sum, route) => sum + route.expectedCostMicros, 0);
if (expectedCost > maxExpectedCostMicros) {
	throw new Error(
		`Expected cost ${expectedCost} exceeds PROVIDER_SMOKE_MAX_EXPECTED_COST_MICROS=${maxExpectedCostMicros}`,
	);
}

void runProviderSmoke();

async function runProviderSmoke(): Promise<void> {
	console.log(
		`Budget gate passed for ${routes.length} invocation(s), maximum expected cost ${expectedCost} micros`,
	);
	if (process.env.PROVIDER_SMOKE_CONFIRM_LIVE !== "true") {
		console.log("Dry run only. Set PROVIDER_SMOKE_CONFIRM_LIVE=true to call providers.");
		return;
	}
	const executions = routes.map((route) => ({ route, adapter: createAdapter(route.provider) }));
	for (const { route, adapter } of executions) {
		if (route.provider !== "gemini" && !adapter.cancel) {
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
				input: inputForTier(route.tier, prompt),
			});
			if (submission.failure) {
				throw new Error(
					`${route.provider}/${route.model} rejected smoke: ${submission.failure.code}`,
				);
			}
			if (submission.providerTaskId && adapter.cancel) {
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

function createAdapter(provider: SmokeRoute["provider"]): MediaProviderAdapter {
	switch (provider) {
		case "replicate":
			return new ReplicateProviderAdapter({ apiToken: requiredSecret("REPLICATE_API_TOKEN") });
		case "fal":
			return new FalProviderAdapter({ apiKey: requiredSecret("FAL_API_KEY") });
		case "kie":
			return new KieProviderAdapter({ apiKey: requiredSecret("KIE_API_KEY") });
		case "gemini":
			return new GeminiProviderAdapter({ apiKey: requiredSecret("GEMINI_API_KEY") });
	}
}

function inputForTier(tier: SmokeRoute["tier"], value: string): ProviderExecutionInput {
	return tier.startsWith("video")
		? { kind: "text-to-video", prompt: value, durationSeconds: 1 }
		: { kind: "text-to-image", prompt: value, width: 256, height: 256 };
}

function requiredSecret(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required before any provider call`);
	return value;
}

function requiredCsv(name: string): string[] {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required before any provider call`);
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

function requiredPositiveInteger(name: string): number {
	const value = Number(process.env[name]);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer before any provider call`);
	}
	return value;
}
