import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import { createProviderPort, type AnnualProviderMode } from "./annual-provider-adapters";
import {
	AnnualOperationError,
	auditAnnualProviders,
	auditPayPalAnnualProviders,
	safeFailure,
	type DiagnosticEvidence,
} from "./annual-provider-core";
import { parsePriorAttempts } from "./annual-provider-prepare";
import {
	auditWaffoAnnualVersions,
	decodeVersionBaseline,
	updateWaffoAnnualProductionVersions,
	type VersionReceipt,
} from "./annual-provider-versions";
import { readCloudflareBuildEnvironment } from "./build-secrets";

export async function runAnnualProviderCli(
	args: string[],
	environment: Record<string, string | undefined> = process.env,
) {
	const mode = args[0];
	const readonly = mode === "audit" || mode === "audit-paypal" || mode === "audit-waffo-versions";
	const updating = mode === "update-waffo-versions";
	if (
		(!readonly && !updating) ||
		(readonly && args.length !== 1) ||
		(updating &&
			(args.length < 2 ||
				args.length > 3 ||
				!args[1]?.startsWith("--baseline=") ||
				(args[2] !== undefined && !args[2].startsWith("--attempted="))))
	)
		throw new AnnualOperationError("MODE_INVALID");
	const baseline = updating
		? decodeVersionBaseline(args[1]!.slice("--baseline=".length))
		: undefined;
	const priorAttempts = updating
		? parsePriorAttempts(args[2]?.slice("--attempted=".length))
		: undefined;
	// Protected credentials remain in this process; only allowlisted provider evidence is printable.
	const protectedEnvironment = parseEnv(readCloudflareBuildEnvironment(environment));
	const onDiagnostic = (diagnostic: DiagnosticEvidence) =>
		process.stdout.write(`${JSON.stringify({ operation: "20261020annual50", diagnostic })}\n`);
	const onReceipt = (receipt: VersionReceipt) =>
		process.stdout.write(`${JSON.stringify({ receipt })}\n`);
	const providerMode: AnnualProviderMode = updating ? "waffo-update" : "audit";
	const port = createProviderPort(protectedEnvironment, providerMode, {
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
				: mode === "audit-waffo-versions"
					? await auditWaffoAnnualVersions(protectedEnvironment, port)
					: await updateWaffoAnnualProductionVersions(protectedEnvironment, port, baseline!, {
							priorAttempts,
							onReceipt,
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
