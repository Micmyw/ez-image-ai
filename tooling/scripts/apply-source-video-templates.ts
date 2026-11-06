import { readFile, realpath } from "node:fs/promises";

import {
	canonicalSourceTemplateJson,
	encodeSourceTemplatePrices,
	sourceTemplateProvisionSchema,
	sourceTemplateSnapshotSchema,
} from "../../packages/config/video-template-execution.server";
import {
	sourceTemplateDefaults,
	sourceTemplateRoles,
} from "../../packages/config/video-template-library";
import type { MediaTransactionClient } from "../../packages/database/prisma/queries/media/types";
import { applySourceTemplateProvisionBundle } from "../../packages/database/prisma/queries/media/video-source-template-admission";
import {
	assertSourceMaterialImportTarget,
	sourceMaterialImportTargetSchema,
} from "./import-source-template-materials";
import {
	parseSourceTemplateImportReceipt,
	prepareSourceVideoTemplates,
	readSourceTemplateEnvironment,
	resolvePreparedSourceRequest,
	sourceTemplateBundleHash,
	writePrivateSourceTemplateOutput,
} from "./prepare-source-video-templates";

type Environment = Record<string, string | undefined>;
type ApplyArguments = Parameters<typeof applySourceTemplateProvisionBundle>[0];
type ApplyDependencies = {
	database: MediaTransactionClient;
	applyBundle?: typeof applySourceTemplateProvisionBundle;
};

/** Rebuild from pinned source and current prices before asking the DB to validate and atomically apply. */
export async function validateSourceVideoTemplateBundle(input: {
	root: string;
	bundle: unknown;
	target: unknown;
	administratorId: string;
	environment: Environment;
	pricingEnvironment?: Environment;
	now?: Date;
}) {
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(input.administratorId))
		throw new Error("SOURCE_TEMPLATE_ADMINISTRATOR_REQUIRED");
	const target = sourceMaterialImportTargetSchema.parse(input.target);
	assertSourceMaterialImportTarget(target, input.environment);
	if (!input.bundle || typeof input.bundle !== "object" || Array.isArray(input.bundle))
		throw new Error("SOURCE_TEMPLATE_BUNDLE_INVALID");
	const bundle = input.bundle as Record<string, unknown>;
	if (
		bundle.schemaVersion !== 1 ||
		typeof bundle.bundleHash !== "string" ||
		!/^[a-f0-9]{64}$/.test(bundle.bundleHash) ||
		!Array.isArray(bundle.records)
	)
		throw new Error("SOURCE_TEMPLATE_BUNDLE_INVALID");
	const importReceipt = parseSourceTemplateImportReceipt(bundle.importReceipt);
	if (canonicalSourceTemplateJson(importReceipt.target) !== canonicalSourceTemplateJson(target))
		throw new Error("SOURCE_TEMPLATE_TARGET_MISMATCH");
	if (
		sourceTemplateBundleHash({ schemaVersion: 1, importReceipt, records: bundle.records }) !==
		bundle.bundleHash
	)
		throw new Error("SOURCE_TEMPLATE_BUNDLE_HASH_MISMATCH");
	const prepared = await prepareSourceVideoTemplates(input.root, {
		receipt: importReceipt,
		environment: input.pricingEnvironment ?? input.environment,
		now: input.now,
	});
	if (prepared.status !== "READY_TO_APPLY") throw new Error("SOURCE_TEMPLATE_BUNDLE_NOT_READY");
	if (prepared.bundleHash !== bundle.bundleHash) {
		// A previously reviewed full-evidence bundle remains valid when only its lossless
		// storage encoding changed. Its original hash was checked above; no prices are rewritten.
		const repackedRecords = bundle.records.map((item: unknown) => {
			if (!item || typeof item !== "object" || Array.isArray(item))
				throw new Error("SOURCE_TEMPLATE_BUNDLE_CONTENT_CHANGED");
			const record = item as Record<string, unknown>;
			const parsed = sourceTemplateProvisionSchema.safeParse(record.value);
			if (!parsed.success) throw new Error("SOURCE_TEMPLATE_BUNDLE_CONTENT_CHANGED");
			const value = parsed.data;
			if (value.pricingSchemaVersion !== undefined) return record;
			const prices = value.prices.map((price) => {
				if (!("pricingBasis" in price)) throw new Error("SOURCE_TEMPLATE_BUNDLE_CONTENT_CHANGED");
				return price;
			});
			return { ...record, value: { ...value, ...encodeSourceTemplatePrices(prices) } };
		});
		if (
			sourceTemplateBundleHash({ schemaVersion: 1, importReceipt, records: repackedRecords }) !==
			prepared.bundleHash
		)
			throw new Error("SOURCE_TEMPLATE_BUNDLE_CONTENT_CHANGED");
	}
	const records: ApplyArguments["records"] = prepared.records.map((item) => {
		const options = sourceTemplateDefaults(item.templateKey);
		const validationSnapshot = sourceTemplateSnapshotSchema.parse({
			templateKey: item.templateKey,
			version: item.value.version,
			// A validation identity only. The transaction writes real override IDs and versions.
			provision: { id: `prepared-${prepared.bundleHash}`, version: 1 },
			request: {
				templateKey: item.templateKey,
				options,
				inputs: sourceTemplateRoles(item.templateKey, options).map((role) => ({
					role,
					assetId: `unsubmitted-${role}`,
				})),
			},
			transport: resolvePreparedSourceRequest(item.templateKey, options),
			references: item.value.references,
		});
		return { configKey: item.configKey, value: item.value, validationSnapshot };
	});
	return { prepared, target, records };
}

/** No supplier calls. Real current asset/rights/moderation checks and all writes share one DB transaction. */
export async function applySourceVideoTemplates(
	input: Parameters<typeof validateSourceVideoTemplateBundle>[0] & {
		apply: boolean;
		reason?: string;
	},
	dependencies: ApplyDependencies,
) {
	const { prepared, target, records } = await validateSourceVideoTemplateBundle(input);
	const result = await (dependencies.applyBundle ?? applySourceTemplateProvisionBundle)(
		{
			records,
			target,
			bundleHash: prepared.bundleHash,
			administratorId: input.administratorId,
			reason: input.reason ?? `Apply reviewed source video templates ${prepared.bundleHash}`,
			dryRun: !input.apply,
		},
		dependencies.database,
	);
	return {
		schemaVersion: 1 as const,
		bundleHash: prepared.bundleHash,
		target,
		status: result.dryRun
			? ("VALIDATED" as const)
			: result.replayed
				? ("UNCHANGED" as const)
				: ("APPLIED" as const),
		records: result.records,
		generationInvoked: false as const,
		databaseWritten: !result.dryRun && !result.replayed,
	};
}

async function main(args: string[]) {
	let apply = false;
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index++) {
		const key = args[index]!;
		if (key === "--apply") {
			if (apply) throw new Error("SOURCE_TEMPLATE_APPLY_ARGUMENTS_INVALID");
			apply = true;
			continue;
		}
		if (
			![
				"--bundle",
				"--target",
				"--administrator",
				"--environment-file",
				"--output",
				"--reason",
			].includes(key) ||
			options.has(key) ||
			!args[index + 1]
		)
			throw new Error("SOURCE_TEMPLATE_APPLY_ARGUMENTS_INVALID");
		options.set(key, args[++index]!);
	}
	if (!["--bundle", "--target", "--administrator", "--output"].every((key) => options.has(key)))
		throw new Error("SOURCE_TEMPLATE_APPLY_ARGUMENTS_INVALID");
	const root = await realpath(process.cwd());
	const environment = { ...process.env };
	const target = sourceMaterialImportTargetSchema.parse(
		JSON.parse(await readFile(options.get("--target")!, "utf8")),
	);
	assertSourceMaterialImportTarget(target, environment);
	const { createRuntimeDatabaseClient } = await import("../../packages/database/prisma/client");
	const database = createRuntimeDatabaseClient(environment.DATABASE_URL!);
	try {
		const result = await applySourceVideoTemplates(
			{
				root,
				target,
				environment,
				pricingEnvironment: await readSourceTemplateEnvironment(options.get("--environment-file")),
				bundle: JSON.parse(await readFile(options.get("--bundle")!, "utf8")),
				administratorId: options.get("--administrator")!,
				apply,
				reason: options.get("--reason"),
			},
			{ database },
		);
		const output = await writePrivateSourceTemplateOutput(root, options.get("--output")!, result);
		process.stdout.write(
			`${JSON.stringify({
				status: result.status,
				records: result.records.length,
				generationInvoked: false,
				databaseWritten: result.databaseWritten,
				output,
			})}\n`,
		);
	} finally {
		await database.$disconnect();
	}
}
if (/(?:^|[\\/])apply-source-video-templates\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
	void main(process.argv.slice(2)).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "";
		process.stderr.write(
			`${/^(?:SOURCE_TEMPLATE_|VIDEO_)[A-Z0-9_]+$/.test(message) ? message : "SOURCE_TEMPLATE_APPLY_FAILED"}\n`,
		);
		process.exitCode = 1;
	});
}
