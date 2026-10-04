import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { removeOwnedBuildContainer } from "./linux-build-cleanup.mjs";
import { linuxBuildEnvironment, snapshotLinuxBuildSource } from "./linux-build-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const image = "node:22-bookworm-slim";

export async function buildInLinuxContainer(args = []) {
	let outputBase = path.join(root, ".cache/cloudflare-web");
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--linux-container") continue;
		if (args[index] === "--output-dir" && args[index + 1]) {
			outputBase = path.resolve(root, args[++index]);
			continue;
		}
		throw new Error(`UNSUPPORTED_ISOLATED_BUILD_ARGUMENT: ${args[index]}`);
	}
	await mkdir(outputBase, { recursive: true });
	const directory = await mkdtemp(path.join(outputBase, "linux-"));
	const source = path.join(directory, "source");
	const containerName = `ezpic-web-build-${randomUUID().slice(0, 12)}`;
	let containerId;
	let failure;
	const processIds = [];
	const manifest = {
		startedAt: new Date().toISOString(),
		launcherPid: process.pid,
		containerName,
		processIds,
		status: "RUNNING",
		artifactDirectory: path.join(directory, "artifact"),
	};
	const save = () =>
		writeFile(
			path.join(directory, "build-manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
	async function command(executable, commandArgs, { capture = false, allowFailure = false } = {}) {
		const child = spawn(executable, commandArgs, {
			cwd: root,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (child.pid) processIds.push(child.pid);
		let output = "";
		child.stdout.on("data", (data) => {
			output += data.toString();
			if (!capture) process.stdout.write(data);
		});
		child.stderr.on("data", (data) => {
			output += data.toString();
			if (!capture) process.stderr.write(data);
		});
		const status = await new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("close", resolve);
		});
		await save();
		if (status !== 0 && !allowFailure)
			throw new Error(
				`LINUX_BUILD_COMMAND_FAILED: ${executable} ${commandArgs[0]} (exit ${status})`,
			);
		return { status, output: output.trim() };
	}
	const run = (...commandArgs) => command("docker", ["exec", containerId, ...commandArgs]);
	const guarded = (...commandArgs) =>
		command("docker", [
			"exec",
			"--env",
			"NODE_OPTIONS=--import=/workspace/apps/saas/cloudflare/build-network-guard.mjs",
			containerId,
			...commandArgs,
		]);
	async function cleanup() {
		if (containerId) {
			await removeOwnedBuildContainer(command, { containerId, containerName });
			manifest.containerRemoved = true;
		}
		if (
			path.dirname(path.resolve(source)) !== path.resolve(directory) ||
			path.basename(source) !== "source"
		)
			throw new Error("LINUX_BUILD_SNAPSHOT_PATH_INVALID");
		await rm(source, { recursive: true, force: true });
	}
	console.log(`Isolated Linux Cloudflare build: ${directory}`);
	try {
		await command("docker", ["version", "--format", "{{.Server.Version}}"], { capture: true });
		let resolvedImage = await command(
			"docker",
			["image", "inspect", image, "--format", "{{.Id}}"],
			{ capture: true, allowFailure: true },
		);
		if (resolvedImage.status !== 0) {
			await command("docker", ["pull", image]);
			resolvedImage = await command("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {
				capture: true,
			});
		}
		manifest.imageId = resolvedImage.output;
		manifest.head = (await command("git", ["rev-parse", "HEAD"], { capture: true })).output;
		const files = await snapshotLinuxBuildSource(root, source);
		await writeFile(
			path.join(directory, "source-manifest.json"),
			`${JSON.stringify(files, null, 2)}\n`,
		);
		manifest.sourceFiles = files.length;
		const environmentFile = path.join(directory, "build.env");
		await writeFile(
			environmentFile,
			Object.entries(linuxBuildEnvironment(process.env))
				.map(([key, value]) => {
					if (/[\r\n]/.test(value)) throw new Error(`INVALID_PUBLIC_BUILD_VALUE: ${key}`);
					return `${key}=${value}`;
				})
				.join("\n") + "\n",
		);
		containerId = (
			await command(
				"docker",
				[
					"create",
					"--name",
					containerName,
					"--init",
					"--workdir",
					"/workspace",
					"--env-file",
					environmentFile,
					resolvedImage.output,
					"sleep",
					"infinity",
				],
				{ capture: true },
			)
		).output;
		manifest.containerId = containerId;
		await command("docker", ["start", containerId], { capture: true });
		await command("docker", ["cp", `${source}${path.sep}.`, `${containerId}:/workspace`], {
			capture: true,
		});
		console.log("Installing the locked Linux dependencies in the isolated container.");
		await run("corepack", "enable");
		const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
		if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager))
			throw new Error("PINNED_PNPM_VERSION_REQUIRED");
		await run("corepack", "prepare", pkg.packageManager, "--activate");
		// Large native tarballs can exceed pnpm's default request timeout on a
		// fresh, uncached Linux install. Bound concurrency and each request while
		// retaining pnpm's finite retries and the frozen dependency graph.
		await run(
			"pnpm",
			"install",
			"--frozen-lockfile",
			"--prod=false",
			"--fetch-timeout=180000",
			"--network-concurrency=8",
		);
		await run("pnpm", "--filter", "@repo/database", "exec", "prisma", "generate", "--no-hints");
		console.log("Building Next/OpenNext in Linux; only public font downloads are allowed.");
		await guarded("pnpm", "cloudflare:web:build");
		console.log("Bundling the final Worker with Wrangler dry-run.");
		await guarded(
			"pnpm",
			"--filter",
			"saas",
			"exec",
			"wrangler",
			"deploy",
			"--dry-run",
			"--outdir",
			"dist/worker",
		);
		console.log("Executing the actual final Worker artifact in local workerd.");
		await guarded("pnpm", "--filter", "saas", "test:artifact:workerd");
		await mkdir(manifest.artifactDirectory, { recursive: true });
		for (const [from, to] of [
			["dist/worker", "worker"],
			[".open-next/assets", "assets"],
			[".open-next/cache", "cache"],
		]) {
			await command(
				"docker",
				[
					"cp",
					`${containerId}:/workspace/apps/saas/${from}`,
					path.join(manifest.artifactDirectory, to),
				],
				{ capture: true },
			);
		}
		const config = JSON.parse(
			await readFile(path.join(source, "apps/saas/wrangler.jsonc"), "utf8"),
		);
		delete config.$schema;
		config.main = "worker/cloudflare-worker.js";
		config.assets.directory = "assets";
		// This local, closed template accompanies a real bundled artifact. Target
		// names/secrets remain the separately authorized release preparation step.
		await writeFile(
			path.join(manifest.artifactDirectory, "wrangler.json"),
			`${JSON.stringify(config, null, 2)}\n`,
		);
		manifest.status = "PASS";
		manifest.localWorkerd = "PASS";
		console.log(
			`Deployable local artifact and closed binding template: ${manifest.artifactDirectory}`,
		);
	} catch (error) {
		manifest.status = "FAIL";
		manifest.errorCode = error instanceof Error ? error.message : "LINUX_BUILD_FAILED";
		failure = error;
	} finally {
		try {
			await cleanup();
		} catch (error) {
			manifest.status = "FAIL";
			manifest.cleanupError = error instanceof Error ? error.message : "LINUX_BUILD_CLEANUP_FAILED";
			failure ??= error;
		}
		manifest.finishedAt = new Date().toISOString();
		await save();
	}
	if (failure) throw failure;
	return manifest;
}
