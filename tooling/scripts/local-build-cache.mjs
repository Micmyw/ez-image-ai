import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const targets = [".turbo/cache", "apps/saas/.next/cache", "apps/saas/.next/dev/cache"];
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--clean")) {
	throw new Error("Usage: node tooling/scripts/local-build-cache.mjs [--clean]");
}
const clean = args[0] === "--clean";

// Validate every path component; an ignored directory can still be a junction.
function resolveTarget(relative) {
	let current = root;
	for (const part of relative.split("/")) {
		current = path.join(current, part);
		let stat;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Refusing a linked or non-directory cache path: ${current}`);
		}
	}
	if (!current.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Cache path is outside this checkout: ${current}`);
	}
	return current;
}

function measure(directory) {
	let bytes = 0;
	for (const name of readdirSync(directory)) {
		const entry = path.join(directory, name);
		const stat = lstatSync(entry);
		if (stat.isSymbolicLink()) {
			throw new Error(`Refusing a cache containing a symbolic link or junction: ${entry}`);
		}
		bytes += stat.isDirectory() ? measure(entry) : stat.size;
	}
	return bytes;
}

function checkInactive() {
	for (const lock of ["apps/saas/.next/lock", "apps/saas/.next/dev/lock"]) {
		if (existsSync(path.join(root, lock))) {
			throw new Error(`Stop Next.js before cleaning; lock exists: ${lock}`);
		}
	}
}

// Refuse deletion if these generated directories ever acquire tracked files.
const tracked = spawnSync("git", ["ls-files", "-z", "--", ...targets], {
	cwd: root,
	encoding: "utf8",
});
if (tracked.error || tracked.status !== 0) {
	throw new Error("Unable to verify cache paths against this Git checkout");
}
if (tracked.stdout.length > 0) {
	throw new Error("Refusing to clean a cache containing Git-tracked files");
}
if (clean) checkInactive();

// Validate all three trees before removing any of them. No parent directory is deleted.
const entries = targets.map((relative) => {
	const directory = resolveTarget(relative);
	return { relative, directory, bytes: directory ? measure(directory) : 0 };
});
process.stdout.write(`Checkout: ${root}\n`);
for (const entry of entries) {
	process.stdout.write(`${entry.relative}: ${(entry.bytes / 1024 ** 3).toFixed(2)} GiB\n`);
}
process.stdout.write(
	`Total file size: ${(entries.reduce((total, entry) => total + entry.bytes, 0) / 1024 ** 3).toFixed(2)} GiB (disk space reclaimed may differ).\n`,
);

if (clean) {
	checkInactive();
	for (const entry of entries) {
		if (!entry.directory) continue;
		const directory = resolveTarget(entry.relative);
		if (directory !== entry.directory) throw new Error("Cache path changed during inspection");
		rmSync(directory, { recursive: true, force: false });
		process.stdout.write(`Removed: ${entry.relative}\n`);
	}
} else {
	process.stdout.write(
		"Preview only. Stop development, build, and test processes before pnpm cache:clean.\n",
	);
}
