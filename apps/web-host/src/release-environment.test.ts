import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	assertAutomaticReleaseEnvironment,
	assertCloudflareGitCommit,
	migrationDatabaseUrl,
} from "./release-environment";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const assertEnvironment = assertAutomaticReleaseEnvironment;

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
	it.each(["", "2026-09-07.2", "2026-09-13.1", "obsolete-value"])(
		"does not block enabled models on a legacy catalog certificate: %s",
		(versions) => {
			const input = {
				...existingProduction,
				MEDIA_GPT_IMAGE_2_5_FLARE_ENABLED: "true",
				MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: versions,
			};
			expect(() => assertEnvironment(input)).not.toThrow();
			expect(input.MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS).toBe(versions);
		},
	);
	it("allows enabled generation without any catalog certification configuration", () => {
		expect(() =>
			assertEnvironment({ MEDIA_GENERATION_ENABLED: "true", MEDIA_ENABLED_PROVIDERS: "kie" }),
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

	it.each(["website", "jobs"])(
		"runs the %s build past a stale catalog while retaining database validation",
		(target) => {
			const result = spawnSync(
				process.execPath,
				["--import", "tsx", "apps/web-host/src/git-build.ts", "build", target],
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
			expect(result.stderr).toContain("MIGRATION_STATUS_DATABASE_URL_REQUIRED");
			expect(result.stderr).not.toContain("PRODUCTION_CATALOG_NOT_CERTIFIED");
			expect(result.stderr).not.toContain("SyntaxError");
		},
	);

	it("reassembles split build secrets and retains database validation without exposing secrets", () => {
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
		expect(result.stderr).toContain("MIGRATION_STATUS_DATABASE_URL_REQUIRED");
		expect(result.stderr + result.stdout).not.toContain("do-not-print-production-secret");
	});
});
