import { readFileSync } from "node:fs";
import path from "node:path";

import { moderationConfiguration } from "@repo/config";
import { describe, expect, it } from "vitest";

import {
	createProfileArtifacts,
	deploymentProfile,
	profileSettings,
	workersRuntimeEnvironment,
} from "./profiles";

describe("deployment profiles", () => {
	it("defaults to Workers and rejects unknown profiles", () => {
		expect(deploymentProfile({})).toBe("workers");
		expect(deploymentProfile({ EZPIC_DEPLOYMENT_PROFILE: "hybrid" })).toBe("hybrid");
		expect(() => deploymentProfile({ EZPIC_DEPLOYMENT_PROFILE: "typo" })).toThrow(
			"INVALID_DEPLOYMENT_PROFILE",
		);
	});
	it("keeps website identity stable and job identities separate for drain/rollback", () => {
		const workers = profileSettings("workers", "production");
		const hybrid = profileSettings("hybrid", "production");
		expect(workers.websiteName).toBe(hybrid.websiteName);
		expect(workers.jobsName).not.toBe(hybrid.jobsName);
		expect(workers.jobsConfig).toBe("wrangler.workers.jsonc");
		expect(hybrid.jobsConfig).toBe("wrangler.jsonc");
	});
	it("uses Hyperdrive instead of embedding database origin credentials in Workers", () => {
		expect(
			workersRuntimeEnvironment({
				DATABASE_URL: "private-origin",
				DIRECT_URL: "private-migration",
				NODE_EXTRA_CA_CERTS: "/app/ca.crt",
				JOBS_RUNTIME_ENV: "private",
				CLOUDFLARE_API_TOKEN: "private-api-token",
				MEDIA_GENERATION_ENABLED: "false",
				KIE_API_KEY: "runtime-secret",
			}),
		).toEqual({
			NODE_ENV: "production",
			EZPIC_RUNTIME: "workers",
			EZPIC_DATABASE_BINDING: "hyperdrive",
			MEDIA_GENERATION_ENABLED: "false",
			KIE_API_KEY: "runtime-secret",
		});
	});
	it("keeps build, offline evidence, and local test settings out of limited Worker bindings", () => {
		const environment = workersRuntimeEnvironment({
			NEXT_PUBLIC_GOOGLE_ANALYTICS_ID: "G-BUILD-ONLY",
			NEXT_PUBLIC_CLARITY_PROJECT_ID: "build-only",
			NEXT_PUBLIC_SITE_NAME: "compiled-app-name",
			NEXT_PUBLIC_SITE_DESCRIPTION: "compiled-description",
			NEXT_PUBLIC_AVATARS_BUCKET_NAME: "compiled-avatar-bucket",
			EZPIC_ENVIRONMENT_MATRIX_PATH: "offline-matrix.json",
			EZPIC_LAUNCH_EVIDENCE_PATH: "offline-evidence.json",
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "obsolete-certificate",
			E2E_TEST_MEDIA_ADAPTERS: "false",
			E2E_DRAFT_HANDOFF: "false",
			LOAD_TESTING_ENABLED: "false",
			NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
			NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: "public-turnstile-key",
			GUEST_TURNSTILE_SECRET_KEY: "private-turnstile-key",
			PAYPAL_ENVIRONMENT: "sandbox",
			WAFFO_ENVIRONMENT: "test",
			EZPIC_DEPLOYMENT_ENVIRONMENT: "production",
			MEDIA_SAFETY_ADAPTER: "configured",
			MODERATION_TEXT_WAFFO_ENABLED: "true",
			MODERATION_TEXT_SIGHTENGINE_ENABLED: "false",
			MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
			SEEAPI_API_KEY: "x".repeat(16),
			SIGHTENGINE_API_USER: "disabled-scanner-user",
			SIGHTENGINE_API_SECRET: "disabled-scanner-secret",
		});
		expect(environment).toEqual({
			NODE_ENV: "production",
			EZPIC_RUNTIME: "workers",
			EZPIC_DATABASE_BINDING: "hyperdrive",
			NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
			NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY: "public-turnstile-key",
			GUEST_TURNSTILE_SECRET_KEY: "private-turnstile-key",
			PAYPAL_ENVIRONMENT: "sandbox",
			WAFFO_ENVIRONMENT: "test",
			EZPIC_DEPLOYMENT_ENVIRONMENT: "production",
			MEDIA_SAFETY_ADAPTER: "configured",
			MODERATION_TEXT_WAFFO_ENABLED: "true",
			MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			SEEAPI_API_KEY: "x".repeat(16),
		});
		expect(moderationConfiguration(environment)).toEqual({
			textWaffo: true,
			textSightengine: false,
			imageSeeapi: true,
			imageSightengine: false,
		});
	});
	it.each<Record<string, string>>([
		{ MEDIA_SAFETY_ADAPTER: "sightengine" },
		{ MEDIA_SAFETY_ADAPTER: "configured", MODERATION_TEXT_SIGHTENGINE_ENABLED: "true" },
		{ MEDIA_SAFETY_ADAPTER: "configured", MODERATION_IMAGE_SIGHTENGINE_ENABLED: "true" },
	])("retains credentials when Sightengine is enabled: %j", (switches) => {
		expect(
			workersRuntimeEnvironment({
				...switches,
				SIGHTENGINE_API_USER: "enabled-scanner-user",
				SIGHTENGINE_API_SECRET: "enabled-scanner-secret",
			}),
		).toMatchObject({
			SIGHTENGINE_API_USER: "enabled-scanner-user",
			SIGHTENGINE_API_SECRET: "enabled-scanner-secret",
		});
	});
});

const root = path.resolve(import.meta.dirname, "../../..");
function artifacts(profile: "workers" | "hybrid", overrides: Record<string, string> = {}) {
	const config = (file: string) =>
		JSON.parse(readFileSync(path.join(root, file), "utf8")) as Record<string, unknown>;
	return createProfileArtifacts({
		root,
		target: "production",
		profile,
		canonicalOrigin: "https://ezimageai.com",
		websiteTemplate: config("apps/saas/wrangler.jsonc"),
		jobsTemplate: config(`apps/workflows/${profileSettings(profile, "production").jobsConfig}`),
		environment: {
			DATABASE_URL: "postgresql://private:private@origin.example/db",
			BETTER_AUTH_SECRET: "private-auth-secret-at-least-32-characters",
			WORKFLOWS_DISPATCH_SECRET: "private-dispatch-secret-at-least-32-characters",
			WORKFLOWS_DISPATCH_URL: `https://${profileSettings(profile, "production").jobsName}.account.workers.dev/internal/dispatch`,
			CLOUDFLARE_HYPERDRIVE_ID: "a".repeat(32),
			CLOUDFLARE_WEB_CACHE_BUCKET: "website-cache",
			MEDIA_BUCKET_NAME: "private-media",
			MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false",
			...overrides,
		},
	});
}

describe("prepared deployment artifacts", () => {
	it("rejects more than 128 text bindings before uploading either Worker", () => {
		const extras = Object.fromEntries(
			Array.from({ length: 128 }, (_, index) => [`EXTRA_${index}`, "value"]),
		);
		expect(() => artifacts("workers", extras)).toThrow("WORKER_TEXT_BINDING_LIMIT");
	});
	it("enables the website workers.dev address only for an explicitly configured callback origin", () => {
		const webhookOrigin = "https://ezimageai-site-production.account.workers.dev";
		expect(artifacts("workers").website.workers_dev).toBe(false);
		const value = artifacts("workers", { PAYMENT_WEBHOOK_INGRESS_ORIGIN: webhookOrigin });
		expect(value.website.workers_dev).toBe(true);
		expect(value.website.vars).toMatchObject({ PAYMENT_WEBHOOK_INGRESS_ORIGIN: webhookOrigin });
		expect(value["website.secrets"]).not.toHaveProperty("PAYMENT_WEBHOOK_INGRESS_ORIGIN");
	});
	it.each([
		"http://ezimageai-site-production.account.workers.dev",
		"https://ezimageai-site-production.other-account.workers.dev",
		"https://another.account.workers.dev",
		"https://ezimageai-site-production.account.workers.dev/api/webhooks/payments",
		"https://ezimageai-site-production.account.workers.dev?unexpected=1",
	])("rejects a callback origin outside this website and Workers account: %s", (webhookOrigin) => {
		expect(() => artifacts("workers", { PAYMENT_WEBHOOK_INGRESS_ORIGIN: webhookOrigin })).toThrow(
			"INVALID_PAYMENT_WEBHOOK_INGRESS_ORIGIN",
		);
	});
	it("builds the default pair without Containers and without public secrets", () => {
		const value = artifacts("workers");
		for (const config of [value.website, value.workflows]) {
			expect(config.containers).toBeUndefined();
			expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
			expect(JSON.stringify(config)).not.toContain("private-auth-secret");
			expect(JSON.stringify(config)).not.toContain("postgresql:");
		}
		expect(value["website.secrets"]).not.toHaveProperty("DATABASE_URL");
		expect(value["website.secrets"]).not.toHaveProperty("EZPIC_RUNTIME");
		expect(value["workflows.secrets"]).not.toHaveProperty("EZPIC_RUNTIME");
	});
	it("keeps the existing hybrid migration history and Node secret injection", () => {
		const value = artifacts("hybrid");
		expect(value.website.containers).toBeUndefined();
		expect(value.workflows.containers).toHaveLength(1);
		expect(value.workflows.migrations).toEqual([
			{ tag: "v1", new_sqlite_classes: ["JobsContainer"] },
		]);
		const secrets = value["workflows.secrets"];
		expect(secrets).toHaveProperty("JOBS_RUNTIME_ENV");
		expect(JSON.parse(secrets.JOBS_RUNTIME_ENV)).toMatchObject({ EZPIC_RUNTIME: "node" });
	});
	it("rejects mismatched task endpoints and shared media/cache buckets", () => {
		expect(() =>
			artifacts("workers", {
				WORKFLOWS_DISPATCH_URL:
					"https://ezpic-workflows-production.account.workers.dev/internal/dispatch",
			}),
		).toThrow("WORKFLOWS_DISPATCH_PROFILE_MISMATCH");
		expect(() => artifacts("workers", { CLOUDFLARE_WEB_CACHE_BUCKET: "private-media" })).toThrow(
			"WEBSITE_CACHE_MUST_USE_SEPARATE_BUCKET",
		);
		expect(() => artifacts("workers", { CLOUDFLARE_HYPERDRIVE_ID: "0".repeat(32) })).toThrow(
			"CLOUDFLARE_HYPERDRIVE_ID_REQUIRED",
		);
	});
});
