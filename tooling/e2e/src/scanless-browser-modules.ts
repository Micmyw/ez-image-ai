import { readFile } from "node:fs/promises";

import ts from "typescript";

export const SCANLESS_JOB_EVENTS_MODULE = "/__scanless/job-events-client.js";
export const SCANLESS_NOTIFICATION_OBSERVER_MODULE = "/__scanless/notification-observer.js";
export const SCANLESS_NOTIFICATION_OBSERVATION_MODULE = "/__scanless/notification-observation.js";

/** Compile the exact current product source, rather than maintaining a second connector. */
export async function loadScanlessBrowserModules(): Promise<Map<string, string>> {
	const contracts = ts.transpileModule(
		await readFile(
			new URL("../../../packages/jobs/src/realtime/contracts.ts", import.meta.url),
			"utf8",
		),
		{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
	).outputText;
	// Compile the same production contract and resolve its sole runtime package import
	// for both the minimal browser and data-URL unit fixtures. No copied protocol constants.
	const contractsUrl = `data:text/javascript;base64,${Buffer.from(contracts).toString("base64")}`;
	return new Map(
		await Promise.all(
			[
				[
					SCANLESS_JOB_EVENTS_MODULE,
					new URL("../../../apps/saas/modules/media/lib/job-events.ts", import.meta.url),
				],
				[
					SCANLESS_NOTIFICATION_OBSERVER_MODULE,
					new URL("./scanless-browser-notifications.ts", import.meta.url),
				],
				[
					SCANLESS_NOTIFICATION_OBSERVATION_MODULE,
					new URL("./scanless-notification-observation.ts", import.meta.url),
				],
			].map(async ([route, file]) => {
				const source = await readFile(file as URL, "utf8");
				const compiled = ts.transpileModule(source, {
					compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
					reportDiagnostics: true,
				});
				if (compiled.diagnostics?.some((entry) => entry.category === ts.DiagnosticCategory.Error))
					throw new Error("SCANLESS_BROWSER_MODULE_COMPILE_FAILED");
				return [
					route as string,
					compiled.outputText.replaceAll("@repo/jobs/realtime/contracts", contractsUrl),
				] as const;
			}),
		),
	);
}
