import { spawnSync } from "node:child_process";
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
						"NEXT_PUBLIC_SAAS_URL=https://ezimageai.com\nMEDIA_GENERATION_ENABLED=true\nMEDIA_ENABLED_PROVIDERS=kie\nMEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS=2026-09-07.2\n",
				},
			},
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("PRODUCTION_CATALOG_NOT_CERTIFIED");
		expect(result.stderr).not.toContain("SyntaxError");
	});
});
