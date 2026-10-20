import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import { createProviderPort } from "./annual-provider-adapters";
import { AnnualOperationError, auditAnnualProviders, safeFailure } from "./annual-provider-core";
import { readCloudflareBuildEnvironment } from "./build-secrets";

export async function runAnnualProviderCli(
	args: string[],
	environment: Record<string, string | undefined> = process.env,
) {
	if (args.length !== 1 || args[0] !== "audit") throw new AnnualOperationError("MODE_INVALID");
	// Keep protected credentials in this process. Never write the decoded source to disk.
	const protectedEnvironment = parseEnv(readCloudflareBuildEnvironment(environment));
	const result = await auditAnnualProviders(
		protectedEnvironment,
		createProviderPort(protectedEnvironment, "audit", {
			onSchemaFields: (schemaFields) =>
				process.stdout.write(
					`${JSON.stringify({ operation: "20261020annual50", schemaFields })}\n`,
				),
		}),
	);
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return result.ready ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	runAnnualProviderCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			process.stdout.write(
				`${JSON.stringify({ operation: "20261020annual50", outcome: "FAILED", ...safeFailure(error) })}\n`,
			);
			process.exitCode = 1;
		});
}
