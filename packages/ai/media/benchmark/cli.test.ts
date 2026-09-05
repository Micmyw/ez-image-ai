import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runImageEditBenchmarkCli } from "./cli";

const manifestPath = fileURLToPath(
	new URL("../../../../fixtures/image-edit-benchmark/manifest.json", import.meta.url),
);

describe("image edit benchmark CLI", () => {
	it("prints a dry-run-only report by default", async () => {
		let stdout = "";
		let stderr = "";
		const exitCode = await runImageEditBenchmarkCli([], {
			environment: { IMAGE_EDIT_BENCHMARK_MANIFEST: manifestPath },
			readText: (path) => readFile(path, "utf8"),
			writeStdout: (value) => {
				stdout += value;
			},
			writeStderr: (value) => {
				stderr += value;
			},
			now: () => new Date("2026-08-25T00:00:00.000Z"),
		});

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toMatchObject({
			status: "DRY_RUN_ONLY",
			certification: { status: "NOT_COMPLETED" },
			plan: { imageCount: 10, taskCount: 30, plannedInvocations: 60 },
		});
	});

	it("fails closed before loading credentials when live spend is not confirmed", async () => {
		let stdout = "";
		let stderr = "";
		const exitCode = await runImageEditBenchmarkCli(["--live", `--manifest=${manifestPath}`], {
			environment: {},
			readText: (path) => readFile(path, "utf8"),
			writeStdout: (value) => {
				stdout += value;
			},
			writeStderr: (value) => {
				stderr += value;
			},
		});

		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toMatch(/refused.*--confirm-spend/i);
	});
});
