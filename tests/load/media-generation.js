import { check, fail } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";

const MODES = ["fast", "long", "uncertain", "provider-fail"];
const createLatency = new Trend("media_create_latency", true);
const internalQueueLatency = new Trend("media_internal_queue_latency", true);
const baseUrl = assertSafeTarget(__ENV.LOAD_BASE_URL);
const endpoint = __ENV.LOAD_ENDPOINT || "/api/testing/media-load";
const profile = __ENV.LOAD_PROFILE || "smoke";
const runId = assertRunId(__ENV.LOAD_TEST_RUN_ID);
const authToken = assertAuthToken(__ENV.LOAD_AUTH_TOKEN);

export const options = {
	scenarios: profileOptions(profile),
	thresholds: {
		checks: ["rate==1"],
		http_req_failed: ["rate<0.01"],
		media_create_latency: ["p(95)<800"],
		media_internal_queue_latency: ["p(95)<5000"],
	},
};

export function setup() {
	const response = http.get(`${baseUrl}/api/health`, { timeout: "5s" });
	if (response.status !== 200) fail(`load target health check failed: ${response.status}`);
	return { runId };
}

export default function (data) {
	const mode = MODES[(__ITER + __VU) % MODES.length];
	const idempotencyKey = `k6:${data.runId}:${__VU}:${__ITER}`;
	const body = JSON.stringify({
		mode,
		idempotencyKey,
		prompt: "k6 deterministic media generation fixture",
	});
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${authToken}`,
	};
	const response = http.post(`${baseUrl}${endpoint}`, body, {
		headers,
		timeout: "10s",
	});
	createLatency.add(response.timings.duration, { mode });
	const payload = response.json();
	const queueMs = Number(response.headers["X-Internal-Queue-Ms"] || payload?.internalQueueMs);
	if (Number.isFinite(queueMs)) internalQueueLatency.add(queueMs, { mode });
	check(response, {
		"create accepted": (result) =>
			result.status === 200 || result.status === 201 || result.status === 202,
		"idempotency echoed": () => payload?.idempotencyKey === idempotencyKey,
		"scenario echoed": () => payload?.mode === mode,
		"queue latency measured": () => Number.isFinite(queueMs),
	});

	if ((__ITER + __VU) % 10 === 0) {
		const duplicate = http.post(`${baseUrl}${endpoint}`, body, {
			headers,
			timeout: "10s",
		});
		const duplicatePayload = duplicate.json();
		check(duplicate, {
			"duplicate request accepted": (result) => result.status === 200 || result.status === 202,
			"duplicate resolves same job": () => duplicatePayload?.jobId === payload?.jobId,
		});
	}
}

function profileOptions(name) {
	if (name === "steady") {
		return {
			media: {
				executor: "constant-arrival-rate",
				rate: 200,
				timeUnit: "1m",
				duration: "30m",
				preAllocatedVUs: 250,
				maxVUs: 1000,
			},
		};
	}
	if (name === "peak") {
		return {
			media: {
				executor: "constant-arrival-rate",
				rate: 400,
				timeUnit: "1m",
				duration: "5m",
				preAllocatedVUs: 500,
				maxVUs: 1000,
			},
		};
	}
	if (name === "active-1000") {
		return {
			media: { executor: "constant-vus", vus: 1000, duration: __ENV.LOAD_DURATION || "5m" },
		};
	}
	if (name === "smoke") {
		return { media: { executor: "shared-iterations", vus: 8, iterations: 16, maxDuration: "2m" } };
	}
	throw new Error(`Unknown LOAD_PROFILE: ${name}`);
}

function assertSafeTarget(value) {
	if (!value) throw new Error("LOAD_BASE_URL is required");
	const parsed = new URL(value);
	const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
	if (!loopback && __ENV.ALLOW_REMOTE_LOAD_TARGET !== "true") {
		throw new Error("Remote load target requires ALLOW_REMOTE_LOAD_TARGET=true");
	}
	if (!loopback && __ENV.LOAD_TARGET_CONFIRMATION !== parsed.origin) {
		throw new Error("LOAD_TARGET_CONFIRMATION must exactly equal the remote origin");
	}
	return parsed.origin;
}

function assertRunId(value) {
	if (!/^[a-z0-9][a-z0-9-]{5,47}$/i.test(String(value || ""))) {
		throw new Error("LOAD_TEST_RUN_ID must match the server's explicit load run ID");
	}
	return String(value);
}

function assertAuthToken(value) {
	const token = String(value || "");
	if (token.length < 43 || token.length > 256 || !/^[\x21-\x7e]+$/.test(token)) {
		throw new Error("LOAD_AUTH_TOKEN must be a high-entropy token of 43-256 visible ASCII bytes");
	}
	return token;
}
