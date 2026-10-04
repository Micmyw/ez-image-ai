import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const excludedDirectories = new Set([
	".git",
	".codegraph",
	".worktrees",
	"node_modules",
	".next",
	".open-next",
	".source",
	".content-collections",
	".cache",
	".turbo",
	".wrangler",
	"dist",
	"dist-workers",
	"coverage",
	"test-results",
	"playwright-report",
	"output",
	"artifacts",
]);

export function isLinuxBuildSource(relativePath) {
	const segments = relativePath.replaceAll("\\", "/").split("/");
	if (segments.some((segment) => excludedDirectories.has(segment) || segment === ".."))
		return false;
	if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) return false;
	const filename = segments.at(-1);
	return Boolean(
		filename &&
		!/^\.env(?:\.|$)|^\.dev\.vars/.test(filename) &&
		!/\.(?:pem|key|log|tsbuildinfo)$/.test(filename) &&
		!/packages\/database\/prisma\/(?:generated|generated-worker|zod)(?:\/|$)/.test(
			segments.join("/"),
		),
	);
}

// Match deployment.ts's explicit public build inputs. Never forward arbitrary
// host variables, credentials, database URLs or Node preload hooks into Docker.
const publicKeys = new Set([
	"NEXT_PUBLIC_SAAS_URL",
	"NEXT_PUBLIC_SITE_NAME",
	"NEXT_PUBLIC_SITE_DESCRIPTION",
	"NEXT_PUBLIC_SUPPORT_EMAIL",
	"NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION",
	"NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY",
	"NEXT_PUBLIC_AVATARS_BUCKET_NAME",
	"NEXT_PUBLIC_POSTHOG_KEY",
	"NEXT_PUBLIC_POSTHOG_HOST",
	"NEXT_PUBLIC_GOOGLE_ANALYTICS_ID",
	"NEXT_PUBLIC_CLARITY_PROJECT_ID",
	"NEXT_PUBLIC_MIXPANEL_TOKEN",
	"NEXT_PUBLIC_PIRSCH_CODE",
	"NEXT_PUBLIC_PLAUSIBLE_URL",
	"NEXT_PUBLIC_UMAMI_TRACKING_ID",
]);

export function linuxBuildEnvironment(hostEnvironment) {
	const publicValues = Object.fromEntries(
		Object.entries(hostEnvironment).filter(
			([key, value]) => publicKeys.has(key) && typeof value === "string" && value,
		),
	);
	return {
		...publicValues,
		NEXT_PUBLIC_SAAS_URL: publicValues.NEXT_PUBLIC_SAAS_URL ?? "https://ezimageai.com",
		NODE_ENV: "production",
		NEXT_TELEMETRY_DISABLED: "1",
		WRANGLER_SEND_METRICS: "false",
		CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
		DATABASE_URL: "postgresql://build:build@127.0.0.1:1/build_only",
		BETTER_AUTH_SECRET: "isolated-build-placeholder-auth-secret-0000",
		RESEND_API_KEY: "re_isolated_build_only_placeholder",
		MEDIA_GENERATION_ENABLED: "false",
		MEDIA_MODERATION_ENABLED: "false",
		GUEST_MEDIA_ENABLED: "false",
		VIDEO_V1_ENABLED: "false",
		BILLING_ENABLED: "false",
		ERROR_MONITORING_ENABLED: "false",
		MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false",
		MEDIA_PROVIDER_ADAPTER: "kie",
		MEDIA_SAFETY_ADAPTER: "configured",
		MEDIA_ENABLED_PROVIDERS: "",
		MEDIA_RECOVERY_PROVIDERS: "",
		LEGACY_AI_STREAM_ENABLED: "false",
		EZPIC_RUNTIME: "node",
	};
}

/** Copy current tracked/ordinary untracked source; never copy Windows pnpm links. */
export async function snapshotLinuxBuildSource(root, destination) {
	const result = spawnSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{
			cwd: root,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		},
	);
	if (result.status !== 0) throw new Error("LINUX_BUILD_SOURCE_INVENTORY_FAILED");
	const manifest = [];
	for (const relative of [...new Set(result.stdout.split("\0"))]
		.filter(isLinuxBuildSource)
		.sort()) {
		const source = path.join(root, relative);
		let stat;
		try {
			stat = await lstat(source);
		} catch (error) {
			if (error?.code === "ENOENT") continue; // Preserve current tracked deletions.
			throw error;
		}
		if (!stat.isFile()) throw new Error(`LINUX_BUILD_SOURCE_NOT_REGULAR: ${relative}`);
		const target = path.join(destination, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await copyFile(source, target);
		manifest.push({
			path: relative.replaceAll("\\", "/"),
			sha256: createHash("sha256")
				.update(await readFile(target))
				.digest("hex"),
		});
	}
	return manifest;
}
