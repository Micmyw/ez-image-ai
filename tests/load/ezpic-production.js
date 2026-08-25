import { check, fail } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";

import { assertEzPicProviderLoadTarget, safeEzPicLoadPath } from "./ezpic-load-safety.js";

const SCENARIOS = [
	"marketing",
	"upload-concurrency",
	"quote-create",
	"polling",
	"signed-url",
	"admin-aggregate",
];
const METRICS = {
	marketing: new Trend("ezpic_marketing_latency", true),
	"upload-concurrency": new Trend("ezpic_upload_latency", true),
	"quote-create": new Trend("ezpic_quote_create_latency", true),
	polling: new Trend("ezpic_polling_latency", true),
	"signed-url": new Trend("ezpic_signed_url_latency", true),
	"admin-aggregate": new Trend("ezpic_admin_aggregate_latency", true),
};
const METRIC_NAMES = {
	marketing: "ezpic_marketing_latency",
	"upload-concurrency": "ezpic_upload_latency",
	"quote-create": "ezpic_quote_create_latency",
	polling: "ezpic_polling_latency",
	"signed-url": "ezpic_signed_url_latency",
	"admin-aggregate": "ezpic_admin_aggregate_latency",
};
const LATENCY_KEYS = {
	marketing: "LOAD_MARKETING_P95_MS",
	"upload-concurrency": "LOAD_UPLOAD_P95_MS",
	"quote-create": "LOAD_QUOTE_CREATE_P95_MS",
	polling: "LOAD_POLLING_P95_MS",
	"signed-url": "LOAD_SIGNED_URL_P95_MS",
	"admin-aggregate": "LOAD_ADMIN_AGGREGATE_P95_MS",
};
const REQUEST_WEIGHTS = {
	marketing: 1,
	"upload-concurrency": 2,
	"quote-create": 2,
	polling: 1,
	"signed-url": 1,
	"admin-aggregate": 1,
};
const PROFILE_ITERATIONS = { smoke: 10, steady: 1000, peak: 2000 };
const plan = assertPlan(__ENV);

export const options = {
	scenarios: buildK6Scenarios(plan),
	thresholds: buildThresholds(plan),
};

export function setup() {
	if (__ENV.LOAD_EXECUTION_CONFIRMATION !== `${plan.runId}:execute`) {
		fail("LOAD_EXECUTION_CONFIRMATION does not exactly confirm this bounded run");
	}
	const health = http.get(`${plan.saasOrigin}/api/health`, { timeout: "10s" });
	if (health.status !== 200) fail(`SaaS health check failed with status ${health.status}`);
	return { runId: plan.runId };
}

export function marketing() {
	const response = http.get(
		`${plan.marketingOrigin}${safeEzPicLoadPath(__ENV.LOAD_MARKETING_PATH || "/")}`,
		{
			timeout: "15s",
		},
	);
	record("marketing", response, (status) => status >= 200 && status < 400);
}

export function uploadConcurrency() {
	const response = http.post(
		`${plan.saasOrigin}${safeEzPicLoadPath(__ENV.LOAD_UPLOAD_PATH || "/api/media/upload-sessions")}`,
		JSON.stringify(requiredJsonObject("LOAD_UPLOAD_BODY")),
		{ headers: userHeaders(), timeout: "20s" },
	);
	METRICS["upload-concurrency"].add(response.timings.duration);
	const payload = safeJson(response);
	const sessionId = payload?.sessionId || payload?.id || payload?.session?.id;
	const created = check(response, {
		"upload session created": (result) => result.status >= 200 && result.status < 300,
		"upload session id returned": () => typeof sessionId === "string" && sessionId.length > 0,
	});
	if (!created || typeof sessionId !== "string") return;
	const abortPath = safeEzPicLoadPath(
		(
			__ENV.LOAD_UPLOAD_ABORT_PATH_TEMPLATE || "/api/media/upload-sessions/{sessionId}/abort"
		).replace("{sessionId}", encodeURIComponent(sessionId)),
	);
	const aborted = http.post(`${plan.saasOrigin}${abortPath}`, "{}", {
		headers: userHeaders(),
		timeout: "20s",
	});
	METRICS["upload-concurrency"].add(aborted.timings.duration);
	check(aborted, { "upload session cleanup accepted": (result) => result.status < 300 });
}

export function quoteCreate(data) {
	if (!plan.remote) {
		const token = requiredOpaque("LOAD_AUTH_TOKEN", 43, 256);
		const response = http.post(
			`${plan.saasOrigin}${safeEzPicLoadPath(__ENV.LOAD_LOCAL_QUOTE_CREATE_PATH || "/api/testing/media-load")}`,
			JSON.stringify({
				mode: "fast",
				idempotencyKey: `k6:${data.runId}:${__VU}:${__ITER}`,
				prompt: "bounded production-like load fixture",
			}),
			{
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				timeout: "20s",
			},
		);
		record("quote-create", response, (status) => status === 200 || status === 202);
		return;
	}

	if (!plan.providerCallsEnabled)
		fail("Remote quote/create requires the confirmed Provider budget");
	const quote = http.post(
		`${plan.saasOrigin}${safeEzPicLoadPath(__ENV.LOAD_QUOTE_PATH || "/api/media/quotes")}`,
		JSON.stringify(requiredJsonObject("LOAD_QUOTE_BODY")),
		{ headers: userHeaders(), timeout: "20s" },
	);
	METRICS["quote-create"].add(quote.timings.duration);
	const quotePayload = safeJson(quote);
	const quoteId = quotePayload?.quoteId || quotePayload?.id || quotePayload?.quote?.id;
	const quoted = check(quote, {
		"quote accepted": (result) => result.status >= 200 && result.status < 300,
		"quote id returned": () => typeof quoteId === "string" && quoteId.length > 0,
	});
	if (!quoted || typeof quoteId !== "string") return;
	const createBody = requiredJsonObject("LOAD_CREATE_BODY");
	const created = http.post(
		`${plan.saasOrigin}${safeEzPicLoadPath(__ENV.LOAD_CREATE_PATH || "/api/media/generations")}`,
		JSON.stringify({
			...createBody,
			quoteId,
			idempotencyKey: `k6:${data.runId}:${__VU}:${__ITER}`,
		}),
		{ headers: userHeaders(), timeout: "20s" },
	);
	record("quote-create", created, (status) => status >= 200 && status < 300);
}

export function polling() {
	const jobId = encodeURIComponent(requiredOpaque("LOAD_POLL_JOB_ID", 8, 200));
	const path = safeEzPicLoadPath(
		(__ENV.LOAD_POLL_PATH_TEMPLATE || "/api/media/jobs/{jobId}").replace("{jobId}", jobId),
	);
	const response = http.get(`${plan.saasOrigin}${path}`, {
		headers: userHeaders(),
		timeout: "10s",
	});
	record("polling", response, (status) => status === 200);
}

export function signedUrl() {
	const assetId = encodeURIComponent(requiredOpaque("LOAD_SIGNED_URL_ASSET_ID", 8, 200));
	const path = safeEzPicLoadPath(
		(__ENV.LOAD_SIGNED_URL_PATH_TEMPLATE || "/api/media/assets/{assetId}/access").replace(
			"{assetId}",
			assetId,
		),
	);
	const response = http.get(`${plan.saasOrigin}${path}`, {
		headers: userHeaders(),
		timeout: "10s",
	});
	record("signed-url", response, (status) => status === 200);
}

export function adminAggregate() {
	const response = http.get(
		`${plan.saasOrigin}${safeEzPicLoadPath(__ENV.LOAD_ADMIN_AGGREGATE_PATH || "/api/admin/media/growth-operations")}`,
		{ headers: adminHeaders(), timeout: "20s" },
	);
	record("admin-aggregate", response, (status) => status === 200);
}

function buildK6Scenarios(input) {
	const executions = {
		marketing: "marketing",
		"upload-concurrency": "uploadConcurrency",
		"quote-create": "quoteCreate",
		polling: "polling",
		"signed-url": "signedUrl",
		"admin-aggregate": "adminAggregate",
	};
	return Object.fromEntries(
		input.scenarios.map((scenario) => [
			scenario,
			{
				executor: "shared-iterations",
				exec: executions[scenario],
				iterations: input.iterationsPerScenario,
				vus: Math.min(input.iterationsPerScenario, input.profile === "smoke" ? 5 : 100),
				maxDuration: input.profile === "smoke" ? "2m" : "30m",
			},
		]),
	);
}

function buildThresholds(input) {
	const thresholds = {
		checks: ["rate==1"],
		http_req_failed: [`rate<${input.maximumErrorRateBasisPoints / 10_000}`],
	};
	for (const scenario of input.scenarios) {
		thresholds[METRIC_NAMES[scenario]] = [`p(95)<${input.latencyBudgetsMs[scenario]}`];
	}
	return thresholds;
}

function assertPlan(environment) {
	const saas = origin(environment.LOAD_BASE_URL, "LOAD_BASE_URL");
	const marketingOrigin = origin(environment.LOAD_MARKETING_BASE_URL, "LOAD_MARKETING_BASE_URL");
	const saasLocal = isLoopback(saas);
	const marketingLocal = isLoopback(marketingOrigin);
	if (saasLocal !== marketingLocal)
		throw new Error("Load origins must both be local or both remote");
	const remote = !saasLocal;
	if (remote) {
		if (saas.protocol !== "https:" || marketingOrigin.protocol !== "https:") {
			throw new Error("Remote load targets must use HTTPS");
		}
		if (environment.ALLOW_REMOTE_LOAD_TARGET !== "true") {
			throw new Error("Remote load targets require ALLOW_REMOTE_LOAD_TARGET=true");
		}
		const allowlist = new Set(requiredCsv(environment.LOAD_REMOTE_TARGET_ALLOWLIST));
		if (!allowlist.has(saas.origin) || !allowlist.has(marketingOrigin.origin)) {
			throw new Error("Every remote load origin must be in LOAD_REMOTE_TARGET_ALLOWLIST");
		}
		if (environment.LOAD_TARGET_CONFIRMATION !== `${saas.origin}|${marketingOrigin.origin}`) {
			throw new Error("LOAD_TARGET_CONFIRMATION must exactly match both remote origins");
		}
		if (
			environment.LOAD_TARGET_ENVIRONMENT !== "staging" ||
			environment.LOAD_TARGET_ENVIRONMENT_CONFIRMATION !== "staging"
		) {
			throw new Error("Remote load is limited to an explicitly confirmed staging environment");
		}
	}
	const runId = requiredOpaque("LOAD_TEST_RUN_ID", 6, 48);
	if (!/^[a-z0-9][a-z0-9-]{5,47}$/i.test(runId)) throw new Error("Invalid LOAD_TEST_RUN_ID");
	const profile = environment.LOAD_PROFILE || "smoke";
	if (!(profile in PROFILE_ITERATIONS))
		throw new Error("LOAD_PROFILE must be smoke, steady, or peak");
	const scenarios = environment.LOAD_SCENARIOS
		? requiredCsv(environment.LOAD_SCENARIOS)
		: [...SCENARIOS];
	if (new Set(scenarios).size !== scenarios.length)
		throw new Error("LOAD_SCENARIOS has duplicates");
	for (const scenario of scenarios) {
		if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown LOAD_SCENARIOS entry: ${scenario}`);
	}
	const iterationsPerScenario = PROFILE_ITERATIONS[profile];
	const plannedRequests =
		iterationsPerScenario * scenarios.reduce((sum, scenario) => sum + REQUEST_WEIGHTS[scenario], 0);
	const maximumRequests = positiveInteger(environment.LOAD_MAX_REQUESTS, "LOAD_MAX_REQUESTS", 1e6);
	if (plannedRequests > maximumRequests) {
		throw new Error(`LOAD_MAX_REQUESTS is below the planned ${plannedRequests} request ceiling`);
	}
	const maximumErrorRateBasisPoints = positiveInteger(
		environment.LOAD_MAX_ERROR_RATE_BPS,
		"LOAD_MAX_ERROR_RATE_BPS",
		10000,
	);
	const latencyBudgetsMs = Object.fromEntries(
		SCENARIOS.map((scenario) => [
			scenario,
			positiveInteger(environment[LATENCY_KEYS[scenario]], LATENCY_KEYS[scenario], 900000),
		]),
	);
	const providerCallsEnabled = boolean(
		environment.LOAD_PROVIDER_CALLS_ENABLED,
		"LOAD_PROVIDER_CALLS_ENABLED",
	);
	assertEzPicProviderLoadTarget(providerCallsEnabled, remote);
	const maximumExpectedProviderCostMicros = nonnegativeInteger(
		environment.LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS,
		"LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS",
	);
	if (providerCallsEnabled) {
		if (!scenarios.includes("quote-create")) throw new Error("Provider calls require quote-create");
		if (maximumExpectedProviderCostMicros <= 0)
			throw new Error("Provider cost budget must be positive");
		if (
			environment.LOAD_PROVIDER_SPEND_CONFIRMATION !==
			`${runId}:${maximumExpectedProviderCostMicros}`
		) {
			throw new Error("LOAD_PROVIDER_SPEND_CONFIRMATION must exactly confirm run and budget");
		}
		const perCreate = positiveInteger(
			environment.LOAD_PROVIDER_COST_PER_CREATE_MICROS,
			"LOAD_PROVIDER_COST_PER_CREATE_MICROS",
			Number.MAX_SAFE_INTEGER,
		);
		if (iterationsPerScenario * perCreate > maximumExpectedProviderCostMicros) {
			throw new Error("Planned Provider cost exceeds LOAD_MAX_EXPECTED_PROVIDER_COST_MICROS");
		}
	} else if (maximumExpectedProviderCostMicros !== 0) {
		throw new Error("Provider-disabled load requires zero Provider cost budget");
	}
	return {
		profile,
		runId,
		remote,
		saasOrigin: saas.origin,
		marketingOrigin: marketingOrigin.origin,
		scenarios,
		iterationsPerScenario,
		plannedRequests,
		maximumErrorRateBasisPoints,
		latencyBudgetsMs,
		providerCallsEnabled,
	};
}

function record(scenario, response, accepted) {
	METRICS[scenario].add(response.timings.duration);
	check(response, { [`${scenario} request accepted`]: (result) => accepted(result.status) });
}

function userHeaders() {
	return sessionHeaders(requiredOpaque("LOAD_USER_SESSION_COOKIE", 20, 4096));
}

function adminHeaders() {
	return sessionHeaders(requiredOpaque("LOAD_ADMIN_SESSION_COOKIE", 20, 4096));
}

function sessionHeaders(value) {
	return { "Content-Type": "application/json", Cookie: value };
}

function safeJson(response) {
	try {
		const value = response.json();
		return value && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

function requiredJsonObject(name) {
	const raw = String(__ENV[name] || "");
	if (!raw || raw.length > 65536) throw new Error(`${name} must be a bounded JSON object`);
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${name} must be a JSON object`);
	}
	return parsed;
}

function origin(value, name) {
	if (!value) throw new Error(`${name} is required`);
	const parsed = new URL(value);
	if (
		!["http:", "https:"].includes(parsed.protocol) ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash ||
		parsed.hostname.endsWith(".invalid")
	) {
		throw new Error(`${name} must be a credential-free origin`);
	}
	return parsed;
}

function isLoopback(url) {
	return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
}

function requiredCsv(value) {
	const values = String(value || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (values.length === 0) throw new Error("A required comma-separated value is empty");
	return values;
}

function requiredOpaque(name, minimum, maximum) {
	const value = String(__ENV[name] || "");
	if (value.length < minimum || value.length > maximum || /[\r\n]/.test(value)) {
		throw new Error(`${name} is missing or invalid`);
	}
	return value;
}

function positiveInteger(value, name, maximum) {
	if (!/^[1-9]\d*$/.test(String(value || "")))
		throw new Error(`${name} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum)
		throw new Error(`${name} exceeds its safety limit`);
	return parsed;
}

function nonnegativeInteger(value, name) {
	if (!/^\d+$/.test(String(value || ""))) throw new Error(`${name} must be a nonnegative integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds its safety limit`);
	return parsed;
}

function boolean(value, name) {
	if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
	return value === "true";
}
