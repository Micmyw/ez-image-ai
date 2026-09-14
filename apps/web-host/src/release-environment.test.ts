import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { describe, expect, it } from "vitest";

import {
	assertAutomaticReleaseEnvironment,
	assertCloudflareGitCommit,
	migrationDatabaseUrl,
} from "./release-environment";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const assertEnvironment = (environment: Record<string, string>) =>
	assertAutomaticReleaseEnvironment(environment, DEFAULT_PRODUCT_CONFIG.catalogVersion);

describe("automatic production release preflight", () => {
	it("accepts the exact Cloudflare main build and rejects preview branches or a different checkout", () => {
		const sha = "a".repeat(40);
		const input = { WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", WORKERS_CI_COMMIT_SHA: sha };
		expect(() => assertCloudflareGitCommit(input, sha)).not.toThrow();
		expect(() =>
			assertCloudflareGitCommit({ ...input, WORKERS_CI_BRANCH: "feature" }, sha),
		).toThrow("PRODUCTION_MAIN_BRANCH_REQUIRED");
		expect(() => assertCloudflareGitCommit(input, "b".repeat(40))).toThrow(
			"CLOUDFLARE_BUILD_COMMIT_MISMATCH",
		);
	});
	const environment = {
		MEDIA_GENERATION_ENABLED: "true",
		MEDIA_ENABLED_PROVIDERS: "kie",
		MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "2026-09-07.2",
	};
	const existingProduction = {
		...environment,
		NODE_ENV: "production",
		MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
		MEDIA_SEEDREAM_4_5_ENABLED: "true",
		MEDIA_SEEDREAM_5_LITE_ENABLED: "true",
		MEDIA_SEEDREAM_5_PRO_ENABLED: "true",
	};
	it("preserves the reviewed models only within the historical September 13 catalog", () => {
		expect(() =>
			assertAutomaticReleaseEnvironment(existingProduction, "2026-09-13.1"),
		).not.toThrow();
		expect(existingProduction.MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS).toBe("2026-09-07.2");
	});
	it("requires fresh evidence for the current text-capable catalog even for previously reviewed models", () => {
		for (const version of ["2026-09-07.2", "2026-09-13.1"]) {
			expect(() =>
				assertEnvironment({
					...existingProduction,
					MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: version,
				}),
			).toThrow(`require reviewed evidence for ${DEFAULT_PRODUCT_CONFIG.catalogVersion}`);
		}
	});
	it("does not extend that prior approval to a newly enabled model or a future catalog", () => {
		expect(() =>
			assertEnvironment({ ...existingProduction, MEDIA_GPT_IMAGE_2_5_FLARE_ENABLED: "true" }),
		).toThrow("PRODUCTION_CATALOG_NOT_CERTIFIED");
		expect(() => assertAutomaticReleaseEnvironment(existingProduction, "2026-10-01.1")).toThrow(
			"PRODUCTION_CATALOG_NOT_CERTIFIED",
		);
	});
	it("blocks the stale production catalog before any Worker is changed", () => {
		expect(() => assertEnvironment(environment)).toThrow("PRODUCTION_CATALOG_NOT_CERTIFIED");
		expect(environment.MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS).toBe("2026-09-07.2");
	});
	it("accepts a reviewed active version while retaining previous versions", () => {
		expect(() =>
			assertEnvironment({
				...environment,
				MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: `2026-09-07.2, ${DEFAULT_PRODUCT_CONFIG.catalogVersion}`,
			}),
		).not.toThrow();
	});
	it("does not require activating generation to deploy a closed product", () => {
		expect(() =>
			assertEnvironment({ ...environment, MEDIA_GENERATION_ENABLED: "false" }),
		).not.toThrow();
	});
	it("keeps hybrid cutover a separately managed operation", () => {
		expect(() => assertEnvironment({ ...environment, EZPIC_DEPLOYMENT_PROFILE: "hybrid" })).toThrow(
			"AUTOMATIC_DEPLOYMENT_REQUIRES_WORKERS_PROFILE",
		);
	});
	it("remaps the Windows CA path for the runner without weakening TLS", () => {
		const url = new URL(
			migrationDatabaseUrl(
				{
					DATABASE_URL:
						"postgresql://app:private@db.example.com/db?sslmode=verify-full&sslrootcert=D:/repo/tooling/certificates/supabase-prod-ca-2021.crt",
				},
				"/runner/repo",
			),
		);
		expect(url.searchParams.get("sslmode")).toBe("verify-full");
		expect(url.searchParams.get("sslrootcert")?.replaceAll("\\", "/")).toBe(
			"/runner/repo/tooling/certificates/supabase-prod-ca-2021.crt",
		);
		expect(url.password).toBe("private");
	});
	it("does not echo a malformed database secret", () => {
		expect(() => migrationDatabaseUrl({ DATABASE_URL: "private-invalid-url" }, "/repo")).toThrow(
			"MIGRATION_STATUS_DATABASE_URL_REQUIRED",
		);
		expect(() =>
			migrationDatabaseUrl({ DATABASE_URL: "postgresql://app:private@db.example.com/db" }, "/repo"),
		).toThrow("MIGRATION_STATUS_REQUIRES_VERIFIED_TLS");
	});

	it("executes the real ESM release CLI and stops a stale catalog before writing configuration", () => {
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "apps/web-host/src/git-build.ts", "build", "website"],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					CLOUDFLARE_PRODUCTION_ENV:
						"NEXT_PUBLIC_SAAS_URL=https://ezimageai.com\nMEDIA_GENERATION_ENABLED=true\nMEDIA_ENABLED_PROVIDERS=kie\nMEDIA_GPT_IMAGE_2_5_FLARE_ENABLED=true\nMEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS=2026-09-07.2\n",
				},
			},
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("PRODUCTION_CATALOG_NOT_CERTIFIED");
		expect(result.stderr).not.toContain("SyntaxError");
	});

	it("reassembles split build secrets before checking the production catalog", () => {
		const source =
			"NEXT_PUBLIC_SAAS_URL=https://ezimageai.com\nMEDIA_GENERATION_ENABLED=true\nMEDIA_ENABLED_PROVIDERS=kie\nMEDIA_GPT_IMAGE_2_5_FLARE_ENABLED=true\nMEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS=2026-09-07.2\nPRIVATE_VALUE=" +
			"do-not-print-production-secret".repeat(220) +
			"\n";
		const digest = createHash("sha256").update(source).digest("hex");
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "apps/web-host/src/git-build.ts", "build", "website"],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					CLOUDFLARE_PRODUCTION_ENV: `parts:2:${digest}`,
					CLOUDFLARE_PRODUCTION_ENV_PART_1: source.slice(0, 4000),
					CLOUDFLARE_PRODUCTION_ENV_PART_2: source.slice(4000),
				},
			},
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("PRODUCTION_CATALOG_NOT_CERTIFIED");
		expect(result.stderr + result.stdout).not.toContain("do-not-print-production-secret");
	});
});
