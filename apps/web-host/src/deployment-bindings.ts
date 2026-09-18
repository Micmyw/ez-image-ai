const retirementCandidates = new Set([
	"MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS",
	"SIGHTENGINE_API_USER",
	"SIGHTENGINE_API_SECRET",
	"MODERATION_TEXT_WAFFO_ENABLED",
	"MODERATION_TEXT_SIGHTENGINE_ENABLED",
	"MODERATION_IMAGE_SEEAPI_ENABLED",
	"MODERATION_IMAGE_SIGHTENGINE_ENABLED",
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
		versionTag: string;
		token: string;
	},
	request: typeof fetch = fetch,
): Promise<{ versionId: string; retired: string[] }> {
	if (!options.token) throw new Error("CLOUDFLARE_API_TOKEN_REQUIRED");
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
	const retired = current.bindings
		.filter(
			({ name, type }) =>
				retirementCandidates.has(name) &&
				!next.has(name) &&
				["secret_text", "plain_text"].includes(type),
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
