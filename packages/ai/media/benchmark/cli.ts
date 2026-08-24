import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	parseImageEditBenchmarkCliArguments,
	runImageEditBenchmark,
	serializeImageEditBenchmarkReport,
} from "./image-edit-benchmark";

interface ImageEditBenchmarkCliDependencies {
	environment?: Record<string, string | undefined>;
	readText?: (path: string) => Promise<string>;
	writeStdout?: (value: string) => void;
	writeStderr?: (value: string) => void;
	now?: () => Date;
}

export async function runImageEditBenchmarkCli(
	args: readonly string[],
	dependencies: ImageEditBenchmarkCliDependencies = {},
): Promise<number> {
	const environment = dependencies.environment ?? process.env;
	const readText = dependencies.readText ?? ((path: string) => readFile(path, "utf8"));
	const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
	const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));
	try {
		const options = parseImageEditBenchmarkCliArguments(args, environment);
		const manifest = JSON.parse(await readText(options.manifestPath)) as unknown;
		const report = await runImageEditBenchmark(
			{
				manifest,
				mode: options.mode,
				confirmSpend: options.confirmSpend,
				maxBudgetMicros: options.maxBudgetMicros,
				routeSelectors: options.routeSelectors,
			},
			{ environment, now: dependencies.now },
		);
		writeStdout(`${serializeImageEditBenchmarkReport(report)}\n`);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown benchmark error";
		writeStderr(`Image edit benchmark refused: ${message}\n`);
		return 1;
	}
}

if (isDirectExecution()) {
	void runImageEditBenchmarkCli(process.argv.slice(2)).then((exitCode) => {
		process.exitCode = exitCode;
	});
}

function isDirectExecution(): boolean {
	const entryPath = process.argv[1];
	return Boolean(entryPath && resolve(entryPath) === resolve(fileURLToPath(import.meta.url)));
}
