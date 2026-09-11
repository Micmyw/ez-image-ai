import path from "node:path";

export type DeploymentProfile = "workers" | "hybrid";

export function deploymentProfile(environment: Record<string, string>): DeploymentProfile {
	const profile = environment.EZPIC_DEPLOYMENT_PROFILE ?? "workers";
	if (profile !== "workers" && profile !== "hybrid") throw new Error("INVALID_DEPLOYMENT_PROFILE");
	return profile;
}

export function createProfileArtifacts(options: {
	root: string;
	target: "staging" | "production";
	profile: DeploymentProfile;
	environment: Record<string, string>;
	canonicalOrigin: string;
	websiteTemplate: Record<string, unknown>;
	jobsTemplate: Record<string, unknown>;
}) {
	const { environment, profile, root, target, canonicalOrigin } = options;
	const settings = profileSettings(profile, target);
	for (const key of ["BETTER_AUTH_SECRET", "WORKFLOWS_DISPATCH_SECRET"])
		if (!environment[key] || environment[key].length < 32)
			throw new Error(`MISSING_OR_SHORT_SECRET: ${key}`);
	if (
		!/^[a-f0-9]{32}$/i.test(environment.CLOUDFLARE_HYPERDRIVE_ID ?? "") ||
		/^0+$/.test(environment.CLOUDFLARE_HYPERDRIVE_ID)
	)
		throw new Error("CLOUDFLARE_HYPERDRIVE_ID_REQUIRED");
	if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(environment.CLOUDFLARE_WEB_CACHE_BUCKET ?? ""))
		throw new Error("CLOUDFLARE_WEB_CACHE_BUCKET_REQUIRED");
	if (environment.CLOUDFLARE_WEB_CACHE_BUCKET === environment.MEDIA_BUCKET_NAME)
		throw new Error("WEBSITE_CACHE_MUST_USE_SEPARATE_BUCKET");
	if (
		environment.MEDIA_ALLOW_TEST_SAFETY_ADAPTER !== "false" ||
		environment.MEDIA_PROVIDER_ADAPTER === "mock" ||
		environment.MEDIA_SAFETY_ADAPTER === "test"
	)
		throw new Error("PRODUCTION_TEST_ADAPTER_FORBIDDEN");
	let dispatch: URL;
	try {
		dispatch = new URL(environment.WORKFLOWS_DISPATCH_URL);
		if (
			dispatch.protocol !== "https:" ||
			dispatch.pathname !== "/internal/dispatch" ||
			dispatch.username ||
			dispatch.password ||
			dispatch.search ||
			dispatch.hash
		)
			throw new Error();
	} catch {
		throw new Error("INVALID_WORKFLOWS_DISPATCH_URL");
	}
	if (
		!dispatch.hostname.endsWith(".workers.dev") ||
		dispatch.hostname.split(".")[0] !== settings.jobsName
	)
		throw new Error(`WORKFLOWS_DISPATCH_PROFILE_MISMATCH: ${settings.jobsName}`);
	const flatEnvironment = workersRuntimeEnvironment(environment);
	const hyperdrive = [{ binding: "HYPERDRIVE", id: environment.CLOUDFLARE_HYPERDRIVE_ID }];
	const account = environment.CLOUDFLARE_ACCOUNT_ID ?? options.jobsTemplate.account_id;
	const website: Record<string, unknown> = {
		...structuredClone(options.websiteTemplate),
		...(account ? { account_id: account } : {}),
		name: settings.websiteName,
		main: path.join(root, "apps/saas/cloudflare-worker.ts"),
		assets: { directory: path.join(root, "apps/saas/.open-next/assets"), binding: "ASSETS" },
		vars: {
			CANONICAL_ORIGIN: canonicalOrigin,
			EZPIC_RUNTIME: "workers",
			MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
		},
		workers_dev: target === "staging",
		...(target === "production"
			? { routes: [{ pattern: new URL(canonicalOrigin).hostname, custom_domain: true }] }
			: {}),
		hyperdrive,
		r2_buckets: [
			{ binding: "NEXT_INC_CACHE_R2_BUCKET", bucket_name: environment.CLOUDFLARE_WEB_CACHE_BUCKET },
		],
		services: [{ binding: "WORKER_SELF_REFERENCE", service: settings.websiteName }],
	};
	const jobsOverrides = (
		options.jobsTemplate.env as Record<string, Record<string, unknown>> | undefined
	)?.[target];
	const jobs: Record<string, unknown> = {
		...structuredClone(options.jobsTemplate),
		...structuredClone(jobsOverrides ?? {}),
		name: settings.jobsName,
	};
	jobs.main = path.join(
		root,
		"apps/workflows",
		profile === "workers" ? "src/workers.ts" : "src/index.ts",
	);
	jobs.workflows = [
		{ name: `ezpic-jobs-${profile}-${target}`, binding: "JOBS", class_name: "JobsWorkflow" },
	];
	if (account) jobs.account_id = account;
	if (profile === "workers") {
		delete jobs.containers;
		jobs.hyperdrive = hyperdrive;
	} else {
		if (!environment.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED_FOR_HYBRID");
		// Retain the existing hybrid Workflow name and Container migration history.
		jobs.workflows = jobsOverrides?.workflows ?? options.jobsTemplate.workflows;
		jobs.containers = (jobs.containers as Array<Record<string, unknown>>).map((container) => ({
			...container,
			image: path.join(root, "apps/jobs-runtime/Dockerfile"),
			image_build_context: root,
		}));
	}
	for (const config of [website, jobs]) {
		delete config.env;
		delete config.$schema;
	}
	const hybridEnvironment: Record<string, string> = { ...environment, EZPIC_RUNTIME: "node" };
	for (const key of Object.keys(hybridEnvironment))
		if (key.startsWith("CLOUDFLARE_")) delete hybridEnvironment[key];
	return {
		website,
		"website.secrets": secretsWithoutVars(flatEnvironment, website),
		workflows: jobs,
		"workflows.secrets":
			profile === "workers"
				? secretsWithoutVars(flatEnvironment, jobs)
				: {
						JOBS_RUNTIME_ENV: JSON.stringify(hybridEnvironment),
						WORKFLOWS_DISPATCH_SECRET: environment.WORKFLOWS_DISPATCH_SECRET,
						WORKFLOWS_DISPATCH_URL: environment.WORKFLOWS_DISPATCH_URL,
					},
	};
}

function secretsWithoutVars(environment: Record<string, string>, config: Record<string, unknown>) {
	const vars = config.vars as Record<string, unknown> | undefined;
	return Object.fromEntries(
		Object.entries(environment).filter(([key]) => !Object.hasOwn(vars ?? {}, key)),
	);
}

export function profileSettings(profile: DeploymentProfile, target: "staging" | "production") {
	return {
		websiteName: `ezimageai-site-${target}`,
		jobsName:
			profile === "workers" ? `ezpic-workflows-workers-${target}` : `ezpic-workflows-${target}`,
		jobsConfig: profile === "workers" ? "wrangler.workers.jsonc" : "wrangler.jsonc",
	};
}

export function workersRuntimeEnvironment(environment: Record<string, string>) {
	return {
		...Object.fromEntries(
			Object.entries(environment).filter(
				([key]) =>
					!/^(?:DATABASE_URL$|DIRECT_URL$|NODE_EXTRA_CA_CERTS$|JOBS_RUNTIME_ENV$|WEB_RUNTIME_ENV$|CLOUDFLARE_|EZPIC_DEPLOYMENT_PROFILE$|EZPIC_WORKERS_BUILD$)/.test(
						key,
					),
			),
		),
		NODE_ENV: "production",
		EZPIC_RUNTIME: "workers",
		EZPIC_DATABASE_BINDING: "hyperdrive",
	};
}
