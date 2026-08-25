export const EZPIC_LOAD_SCENARIOS = [
	"marketing",
	"upload-concurrency",
	"quote-create",
	"polling",
	"signed-url",
	"admin-aggregate",
] as const;

export type EzPicLoadScenario = (typeof EZPIC_LOAD_SCENARIOS)[number];

export interface EzPicProductionLoadPlan {
	profile: "smoke" | "steady" | "peak";
	runId: string;
	remote: boolean;
	targetEnvironment: "local" | "staging";
	saasOrigin: string;
	marketingOrigin: string;
	maximumRequests: number;
	maximumExpectedProviderCostMicros: bigint;
	plannedRequests: number;
	plannedProviderInvocations: number;
	plannedProviderCostMicros: bigint;
	maximumErrorRateBasisPoints: number;
	latencyBudgetsMs: Record<EzPicLoadScenario, number>;
	providerCallsEnabled: boolean;
	scenarios: EzPicLoadScenario[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const REQUESTS_PER_SCENARIO = {
	smoke: 10,
	steady: 1_000,
	peak: 2_000,
} as const;
const REQUESTS_PER_ITERATION: Record<EzPicLoadScenario, number> = {
	marketing: 1,
	"upload-concurrency": 2,
	"quote-create": 2,
	polling: 1,
	"signed-url": 1,
	"admin-aggregate": 1,
};

export function resolveEzPicProductionLoadPlan(
	input: Record<string, string | undefined>,
): EzPicProductionLoadPlan {
	const saas = loadOrigin(required(input, "LOAD_BASE_URL"), "LOAD_BASE_URL");
	const marketing = loadOrigin(
		required(input, "LOAD_MARKETING_BASE_URL"),
		"LOAD_MARKETING_BASE_URL",
	);
	const saasLoopback = LOOPBACK_HOSTS.has(saas.hostname);
	const marketingLoopback = LOOPBACK_HOSTS.has(marketing.hostname);
	if (saasLoopback !== marketingLoopback) {
		throw new Error("LOAD_BASE_URL and LOAD_MARKETING_BASE_URL must both be local or both remote");
	}
	const remote = !saasLoopback;
	const maximumRequests = requiredPositiveInteger(input, "LOAD_MAX_REQUESTS", 1_000_000);
	const maximumErrorRateBasisPoints = requiredPositiveInteger(
		input,
		"LOAD_MAX_ERROR_RATE_BPS",
		10_000,
	);
	const latencyBudgetsMs: Record<EzPicLoadScenario, number> = {
		marketing: requiredPositiveInteger(input, "LOAD_MARKETING_P95_MS", 900_000),
		"upload-concurrency": requiredPositiveInteger(input, "LOAD_UPLOAD_P95_MS", 900_000),
		"quote-create": requiredPositiveInteger(input, "LOAD_QUOTE_CREATE_P95_MS", 900_000),
		polling: requiredPositiveInteger(input, "LOAD_POLLING_P95_MS", 900_000),
		"signed-url": requiredPositiveInteger(input, "LOAD_SIGNED_URL_P95_MS", 900_000),
		"admin-aggregate": requiredPositiveInteger(input, "LOAD_ADMIN_AGGREGATE_P95_MS", 900_000),
	};
	const maximumExpectedProviderCostMicros = requiredNonnegativeBigInt(
		input,
		"LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS",
	);
	const providerCallsEnabled = requiredBoolean(input, "LOAD_PROVIDER_CALLS_ENABLED");
	const runId = required(input, "LOAD_TEST_RUN_ID");
	if (!/^[a-z0-9][a-z0-9-]{5,47}$/i.test(runId)) {
		throw new Error("LOAD_TEST_RUN_ID must be a bounded explicit run identifier");
	}
	let targetEnvironment: "local" | "staging" = "local";
	if (remote) {
		if (saas.protocol !== "https:" || marketing.protocol !== "https:") {
			throw new Error("Remote load targets must use HTTPS");
		}
		if (input.ALLOW_REMOTE_LOAD_TARGET !== "true") {
			throw new Error("Remote load targets require ALLOW_REMOTE_LOAD_TARGET=true");
		}
		const allowlist = new Set(csv(input, "LOAD_REMOTE_TARGET_ALLOWLIST"));
		for (const origin of [saas.origin, marketing.origin]) {
			if (!allowlist.has(origin))
				throw new Error(`Remote load target is not allowlisted: ${origin}`);
		}
		if (input.LOAD_TARGET_CONFIRMATION !== `${saas.origin}|${marketing.origin}`) {
			throw new Error("LOAD_TARGET_CONFIRMATION must exactly match both remote origins");
		}
		if (
			input.LOAD_TARGET_ENVIRONMENT !== "staging" ||
			input.LOAD_TARGET_ENVIRONMENT_CONFIRMATION !== "staging"
		) {
			throw new Error("Remote load execution is limited to an explicitly confirmed staging target");
		}
		targetEnvironment = "staging";
	}
	if (providerCallsEnabled && !remote) {
		throw new Error("Provider calls require an explicitly confirmed remote staging target");
	}

	const profile = input.LOAD_PROFILE ?? "smoke";
	if (profile !== "smoke" && profile !== "steady" && profile !== "peak") {
		throw new Error("LOAD_PROFILE must be smoke, steady, or peak");
	}
	const scenarios = input.LOAD_SCENARIOS
		? parseScenarios(input.LOAD_SCENARIOS)
		: [...EZPIC_LOAD_SCENARIOS];
	const requestsPerScenario = REQUESTS_PER_SCENARIO[profile];
	const plannedRequests =
		requestsPerScenario *
		scenarios.reduce((sum, scenario) => sum + REQUESTS_PER_ITERATION[scenario], 0);
	if (plannedRequests > maximumRequests) {
		throw new Error(
			`LOAD_MAX_REQUESTS must be at least ${plannedRequests} for the selected profile and scenarios`,
		);
	}

	let plannedProviderInvocations = 0;
	let plannedProviderCostMicros = BigInt(0);
	if (providerCallsEnabled) {
		if (maximumExpectedProviderCostMicros <= BigInt(0)) {
			throw new Error("LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS must be positive for Provider calls");
		}
		if (
			input.LOAD_PROVIDER_SPEND_CONFIRMATION !==
			`${runId}:${maximumExpectedProviderCostMicros.toString()}`
		) {
			throw new Error("LOAD_PROVIDER_SPEND_CONFIRMATION must exactly confirm run and budget");
		}
		if (!scenarios.includes("quote-create")) {
			throw new Error("Provider calls require the quote-create scenario");
		}
		const providerCostPerCreateMicros = requiredPositiveBigInt(
			input,
			"LOAD_PROVIDER_COST_PER_CREATE_MICROS",
		);
		plannedProviderInvocations = requestsPerScenario;
		plannedProviderCostMicros = BigInt(plannedProviderInvocations) * providerCostPerCreateMicros;
		if (plannedProviderCostMicros > maximumExpectedProviderCostMicros) {
			throw new Error(
				`The planned Provider cost ${plannedProviderCostMicros.toString()} exceeds LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS`,
			);
		}
	} else {
		if (maximumExpectedProviderCostMicros !== BigInt(0)) {
			throw new Error("Provider-disabled load plans must use a zero expected Provider cost budget");
		}
		if (
			input.LOAD_PROVIDER_COST_PER_CREATE_MICROS !== undefined &&
			input.LOAD_PROVIDER_COST_PER_CREATE_MICROS !== "0"
		) {
			throw new Error("Provider-disabled load plans cannot declare Provider cost per create");
		}
	}

	return {
		profile,
		runId,
		remote,
		targetEnvironment,
		saasOrigin: saas.origin,
		marketingOrigin: marketing.origin,
		maximumRequests,
		maximumExpectedProviderCostMicros,
		plannedRequests,
		plannedProviderInvocations,
		plannedProviderCostMicros,
		maximumErrorRateBasisPoints,
		latencyBudgetsMs,
		providerCallsEnabled,
		scenarios,
	};
}

function loadOrigin(value: string, key: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${key} must be a valid URL`);
	}
	if (
		!(["http:", "https:"] as string[]).includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		url.hostname.endsWith(".invalid")
	) {
		throw new Error(`${key} must be a credential-free origin`);
	}
	return url;
}

function required(input: Record<string, string | undefined>, key: string): string {
	const value = input[key]?.trim();
	if (!value) throw new Error(`${key} is required`);
	return value;
}

function requiredBoolean(input: Record<string, string | undefined>, key: string): boolean {
	const value = input[key];
	if (value !== "true" && value !== "false") throw new Error(`${key} must be true or false`);
	return value === "true";
}

function requiredPositiveInteger(
	input: Record<string, string | undefined>,
	key: string,
	maximum: number,
): number {
	const value = required(input, key);
	if (!/^[1-9]\d*$/.test(value)) throw new Error(`${key} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		throw new Error(`${key} exceeds its safety limit`);
	}
	return parsed;
}

function requiredNonnegativeBigInt(input: Record<string, string | undefined>, key: string): bigint {
	const value = required(input, key);
	if (!/^\d+$/.test(value)) throw new Error(`${key} must be a nonnegative integer`);
	return BigInt(value);
}

function requiredPositiveBigInt(input: Record<string, string | undefined>, key: string): bigint {
	const value = required(input, key);
	if (!/^[1-9]\d*$/.test(value)) throw new Error(`${key} must be a positive integer`);
	return BigInt(value);
}

function csv(input: Record<string, string | undefined>, key: string): string[] {
	const values = required(input, key)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (new Set(values).size !== values.length) throw new Error(`${key} contains duplicates`);
	return values;
}

function parseScenarios(value: string): EzPicLoadScenario[] {
	const scenarios = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (scenarios.length === 0 || new Set(scenarios).size !== scenarios.length) {
		throw new Error("LOAD_SCENARIOS must contain unique scenario names");
	}
	for (const scenario of scenarios) {
		if (!(EZPIC_LOAD_SCENARIOS as readonly string[]).includes(scenario)) {
			throw new Error(`Unknown LOAD_SCENARIOS entry: ${scenario}`);
		}
	}
	return scenarios as EzPicLoadScenario[];
}
