import {
	EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS,
	parseEzPicImageModelFlags,
	parseVideoRuntimeConfig,
	VIDEO_RUNTIME_ENVIRONMENT_KEYS,
} from "@repo/config/server";

import { retiredModerationBindings } from "./retired-moderation-bindings";

const retirementCandidates = new Set([
	...retiredModerationBindings,
	"MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS",
	"GUEST_SESSION_MAX_ACCEPTED_TRIALS",
	"GUEST_DEVICE_MAX_ACCEPTED_PER_PROMOTION",
	"MODERATION_TEXT_WAFFO_ENABLED",
	"MODERATION_IMAGE_SEEAPI_ENABLED",
]);
const retiredVideoAccessBindings = new Set([
	"VIDEO_V1_ALLOWED_USER_IDS",
	"VIDEO_MODEL_ALLOWED_OPTIONS",
]);

interface WorkerVersion {
	id: string;
	bindings: Array<{ name: string; type: string }>;
}

export async function stageRetiredWorkerBindings(
	options: {
		accountId: string;
		scriptName: string;
		nextBindingNames: string[];
		nextImageModelFlags?: unknown;
		nextVideoRuntimeConfig?: unknown;
		versionTag: string;
		token: string;
	},
	request: typeof fetch = fetch,
): Promise<{ versionId: string; retired: string[] }> {
	if (!options.token) throw new Error("CLOUDFLARE_API_TOKEN_REQUIRED");
	const candidates = new Set(retirementCandidates);
	let packedModelKeys: Set<string> | undefined;
	if (options.nextBindingNames.includes("MEDIA_IMAGE_MODEL_FLAGS")) {
		packedModelKeys = new Set(Object.keys(parseEzPicImageModelFlags(options.nextImageModelFlags)));
		for (const key of packedModelKeys) candidates.add(key);
	}
	let packedVideoKeys: Set<string> | undefined;
	if (options.nextBindingNames.includes("VIDEO_RUNTIME_CONFIG")) {
		packedVideoKeys = new Set(Object.keys(parseVideoRuntimeConfig(options.nextVideoRuntimeConfig)));
		for (const key of packedVideoKeys) candidates.add(key);
		for (const key of retiredVideoAccessBindings) candidates.add(key);
	}
	const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/workers/workers/${encodeURIComponent(options.scriptName)}/versions/latest`;
	async function version(method: "GET" | "PATCH", body?: unknown) {
		const response = await request(url, {
			method,
			headers: {
				Authorization: `Bearer ${options.token}`,
				...(body ? { "Content-Type": "application/merge-patch+json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`WORKER_BINDING_API_FAILED: ${response.status}`);
		const value = (await response.json()) as { success: boolean; result: WorkerVersion };
		if (!value.success || !value.result?.id || !Array.isArray(value.result.bindings))
			throw new Error("WORKER_BINDING_API_INVALID_RESPONSE");
		return value.result;
	}
	const current = await version("GET");
	const next = new Set(options.nextBindingNames);
	if (packedModelKeys) {
		const modelNames = new Set(Object.values(EZPIC_IMAGE_PRODUCT_ENVIRONMENT_KEYS));
		for (const { name, type } of current.bindings) {
			if (
				modelNames.has(name) &&
				["secret_text", "plain_text"].includes(type) &&
				!next.has(name) &&
				!packedModelKeys.has(name)
			)
				throw new Error(`IMAGE_MODEL_BINDING_REPLACEMENT_MISSING: ${name}`);
		}
	}
	if (packedVideoKeys) {
		const videoNames = new Set<string>(Object.values(VIDEO_RUNTIME_ENVIRONMENT_KEYS));
		for (const { name, type } of current.bindings) {
			if (
				videoNames.has(name) &&
				!retiredVideoAccessBindings.has(name) &&
				["secret_text", "plain_text"].includes(type) &&
				!next.has(name) &&
				!packedVideoKeys.has(name)
			)
				throw new Error(`VIDEO_RUNTIME_BINDING_REPLACEMENT_MISSING: ${name}`);
		}
	}
	const retired = current.bindings
		.filter(
			({ name, type }) =>
				candidates.has(name) && !next.has(name) && ["secret_text", "plain_text"].includes(type),
		)
		.map(({ name }) => name);
	if (!retired.length) return { versionId: current.id, retired };
	// The version PATCH creates an undeployed snapshot. The existing deployment
	// keeps its original secrets until Wrangler uploads and deploys the new code.
	const staged = await version("PATCH", {
		env: Object.fromEntries(retired.map((name) => [name, null])),
		annotations: {
			"workers/message": `Prepare retired bindings for ${options.versionTag}; do not deploy this intermediate version`,
		},
	});
	const expected = current.bindings.filter(({ name }) => !retired.includes(name));
	if (
		staged.bindings.length !== expected.length ||
		expected.some(
			({ name, type }) =>
				!staged.bindings.some((binding) => binding.name === name && binding.type === type),
		)
	)
		throw new Error("WORKER_BINDING_SNAPSHOT_MISMATCH");
	return { versionId: staged.id, retired };
}
