import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyProviderDispatchCapacity } from "./provider-capacity-preflight";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const enabled = {
	NODE_ENV: "production",
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
};

describe("production provider dispatch capacity preflight", () => {
	it.each([
		{ VIDEO_V1_PROVIDER_CONCURRENCY: "8" },
		{ VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_PROVIDER_CONCURRENCY: "8" }) },
	])("reports only the configured positive capacity for flat or packed policy", (policy) => {
		expect(
			verifyProviderDispatchCapacity({ ...enabled, ...policy, KIE_API_KEY: "private-fixture" }),
		).toEqual({ code: "KIE_PROVIDER_CAPACITY_PREFLIGHT_OK", capacity: 8 });
	});
	it("retains the runtime's legacy adapter fallback when the explicit provider list is absent", () => {
		expect(() =>
			verifyProviderDispatchCapacity({
				NODE_ENV: "production",
				MEDIA_GENERATION_ENABLED: "true",
				MEDIA_PROVIDER_ADAPTER: "kie",
			}),
		).toThrow("KIE_PROVIDER_CAPACITY_REQUIRED");
	});
	it("requires Kie capacity for enabled native video even when image providers exclude Kie", () => {
		expect(() =>
			verifyProviderDispatchCapacity({
				...enabled,
				MEDIA_ENABLED_PROVIDERS: "fal",
				VIDEO_V1_ENABLED: "true",
			}),
		).toThrow("KIE_PROVIDER_CAPACITY_REQUIRED");
	});
	it.each([undefined, "", "0", "-1", "1.5", "NaN", "9007199254740992"])(
		"never invents a capacity for %s",
		(value) => {
			expect(() =>
				verifyProviderDispatchCapacity({ ...enabled, VIDEO_V1_PROVIDER_CONCURRENCY: value }),
			).toThrow("KIE_PROVIDER_CAPACITY_REQUIRED");
		},
	);
	it.each([
		{ NODE_ENV: "test" },
		{ MEDIA_GENERATION_ENABLED: "false", VIDEO_V1_ENABLED: "true" },
		{ MEDIA_ENABLED_PROVIDERS: "fal", VIDEO_V1_ENABLED: "false" },
		{ MEDIA_ENABLED_PROVIDERS: "", MEDIA_PROVIDER_ADAPTER: "kie" },
		{ MEDIA_ENABLED_PROVIDERS: "fal", MEDIA_RECOVERY_PROVIDERS: "kie" },
	])(
		"does not require Kie capacity for inactive or independent-provider deployments",
		(overrides) => {
			expect(verifyProviderDispatchCapacity({ ...enabled, ...overrides })).toEqual({
				code: "PROVIDER_CAPACITY_PREFLIGHT_INACTIVE",
			});
		},
	);
	it.each([
		{ VIDEO_RUNTIME_CONFIG: "private-malformed-fixture" },
		{
			VIDEO_V1_PROVIDER_CONCURRENCY: "8",
			VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_PROVIDER_CONCURRENCY: "9" }),
		},
		{ MEDIA_ENABLED_PROVIDERS: "kie,private-invalid-provider" },
	])(
		"redacts invalid or conflicting runtime policy without returning the private input",
		(policy) => {
			expect(() => verifyProviderDispatchCapacity({ ...enabled, ...policy })).toThrow(
				"KIE_PROVIDER_CAPACITY_CONFIGURATION_INVALID",
			);
		},
	);
});

describe("automatic builder capacity gate ordering", () => {
	function build(target: string, values: Record<string, string>) {
		return spawnSync(
			process.execPath,
			["--import", "tsx", "apps/web-host/src/git-build.ts", "build", target],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					PATH: process.env.PATH,
					WORKERS_CI: "1",
					WORKERS_CI_BRANCH: "feature-fixture",
					CLOUDFLARE_PRODUCTION_ENV: Object.entries({
						NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
						PRIVATE_KEY: "do-not-print-fixture",
						...values,
					})
						.map(([key, value]) => `${key}=${value}`)
						.join("\n"),
				},
			},
		);
	}
	it.each(["website", "jobs"])(
		"preserves the missing database guard before capacity checks for %s",
		(target) => {
			const result = build(target, enabled);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("MIGRATION_STATUS_DATABASE_URL_REQUIRED");
			expect(result.stderr).not.toContain("KIE_PROVIDER_CAPACITY_REQUIRED");
		},
	);
	it.each(["website", "jobs"])(
		"rejects missing capacity before preparing artifacts or deploying %s",
		(target) => {
			const result = build(target, {
				...enabled,
				DATABASE_URL: "postgresql://fixture:private-fixture@db.invalid/test?sslmode=verify-full",
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("KIE_PROVIDER_CAPACITY_REQUIRED");
			expect(result.stderr).not.toContain("PRODUCTION_MAIN_BRANCH_REQUIRED");
			expect(result.stdout + result.stderr).not.toContain("private-fixture");
			expect(result.stdout + result.stderr).not.toContain("do-not-print-fixture");
		},
	);
	it.each(["website", "jobs"])(
		"logs only approved evidence before the later Git guard for %s",
		(target) => {
			const result = build(target, {
				...enabled,
				DATABASE_URL: "postgresql://fixture:private-fixture@db.invalid/test?sslmode=verify-full",
				VIDEO_V1_PROVIDER_CONCURRENCY: "8",
			});
			expect(result.stderr).toContain("PRODUCTION_MAIN_BRANCH_REQUIRED");
			expect(result.stdout).toContain(
				'Provider dispatch capacity preflight: {"code":"KIE_PROVIDER_CAPACITY_PREFLIGHT_OK","capacity":8}',
			);
			expect(result.stdout + result.stderr).not.toContain("private-fixture");
			expect(result.stdout + result.stderr).not.toContain("do-not-print-fixture");
		},
	);
	it("checks the saved authoritative environment before any live deploy mutation", () => {
		const source = readFileSync(path.join(root, "apps/web-host/src/git-build.ts"), "utf8");
		const deploy = source.slice(source.indexOf('} else if (command === "deploy")'));
		const gate = deploy.indexOf("verifyProviderDispatchCapacity(");
		expect(gate).toBeGreaterThan(deploy.indexOf("assertAutomaticReleaseEnvironment(environment)"));
		expect(deploy.slice(gate)).toMatch(
			/verifyProviderDispatchCapacity\(\s*deploymentEnvironment\(environment,/,
		);
		for (const mutation of ['"populateCache"', "await stageRetiredWorkerBindings(", '"wrangler",'])
			expect(gate).toBeLessThan(deploy.indexOf(mutation));
	});
});
