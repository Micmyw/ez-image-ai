import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import { createProviderPort } from "./annual-provider-adapters";
import {
	AnnualOperationError,
	auditAnnualProviders,
	auditPayPalAnnualProviders,
	safeFailure,
	type DiagnosticEvidence,
} from "./annual-provider-core";
import { prepareAnnualProviders, parsePriorAttempts } from "./annual-provider-prepare";
import { readCloudflareBuildEnvironment } from "./build-secrets";

export async function runAnnualProviderCli(
	args: string[],
	environment: Record<string, string | undefined> = process.env,
) {
	const mode = args[0];
	if (
		(mode !== "audit" && mode !== "audit-paypal" && mode !== "prepare") ||
		args.length > 2 ||
		(args[1] !== undefined && (mode !== "prepare" || !args[1].startsWith("--attempted=")))
	)
		throw new AnnualOperationError("MODE_INVALID");
	const priorAttempts = parsePriorAttempts(args[1]?.slice("--attempted=".length));
	// Keep protected credentials in this process. Never write the decoded source to disk.
	const protectedEnvironment = parseEnv(readCloudflareBuildEnvironment(environment));
	const onDiagnostic = (diagnostic: DiagnosticEvidence) =>
		process.stdout.write(`${JSON.stringify({ operation: "20261020annual50", diagnostic })}\n`);
	const port = createProviderPort(protectedEnvironment, mode === "prepare" ? "prepare" : "audit", {
		onDiagnostic,
		onSchemaFields: (schemaFields) =>
			process.stdout.write(`${JSON.stringify({ operation: "20261020annual50", schemaFields })}\n`),
	});
	const result =
		mode === "audit-paypal"
			? await auditPayPalAnnualProviders(protectedEnvironment, port, {
					onDiagnostic,
					onPlan: (paypalPlan) =>
						process.stdout.write(
							`${JSON.stringify({ operation: "20261020annual50", paypalPlan })}\n`,
						),
				})
			: mode === "audit"
				? await auditAnnualProviders(protectedEnvironment, port, { onDiagnostic })
				: await prepareAnnualProviders(protectedEnvironment, port, {
						priorAttempts,
						onReceipt: (receipt) => process.stdout.write(`${JSON.stringify({ receipt })}\n`),
					});
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
				`${JSON.stringify({ operation: "20261020annual50", outcome: /UNCERTAIN|UNRESOLVED/.test(safeFailure(error).code) ? "UNCERTAIN" : "FAILED", ...safeFailure(error) })}\n`,
			);
			process.exitCode = 1;
		});
}
