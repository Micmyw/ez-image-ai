import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	archivedSourceMaterials,
	prepareArchivedSourceTemplateConfig,
} from "../../packages/ai/media/rap-templates/archive";
import { resolveSourceTemplateRequest } from "../../packages/ai/media/rap-templates/contracts";
import { resolveSourceTemplatePrice } from "../../packages/config/source-template-pricing.server";
import {
	SOURCE_TEMPLATE_CONTRACT_VERSION,
	canonicalSourceTemplateJson,
	encodeSourceTemplatePrices,
	sourceTemplateConfigKey,
	sourceTemplateProvisionSchema,
	sourceTemplateReferenceSchema,
} from "../../packages/config/video-template-execution.server";
import {
	SOURCE_TEMPLATE_KEYS,
	isSourceTemplateKey,
	sourceTemplateDefaults,
	sourceTemplateOptionSets,
	sourceTemplateRoles,
	type SourceTemplateChoices,
	type SourceTemplateKey,
} from "../../packages/config/video-template-library";
import { sourceMaterialImportTargetSchema } from "./import-source-template-materials";

type Environment = Record<string, string | undefined>;
type Target = ReturnType<typeof sourceMaterialImportTargetSchema.parse>;
type Reference = ReturnType<typeof sourceTemplateReferenceSchema.parse>;
export type SourceTemplateImportReceipt = {
	schemaVersion: 1;
	target: Target;
	references: Array<
		Reference & {
			templateKey: SourceTemplateKey;
			version: string;
			approvalKind: "administrator-application" | "test-fixture";
		}
	>;
};
const assetRoot = "packages/ai/media/rap-templates";
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("SOURCE_TEMPLATE_RECEIPT_INVALID");
	return value as Record<string, unknown>;
};

/** Receipts are claims until the apply transaction rechecks their current database evidence. */
export function parseSourceTemplateImportReceipt(value: unknown): SourceTemplateImportReceipt {
	const input = record(value);
	if (input.schemaVersion !== 1 || !Array.isArray(input.references))
		throw new Error("SOURCE_TEMPLATE_RECEIPT_INVALID");
	const target = sourceMaterialImportTargetSchema.parse(input.target);
	const references = input.references.map(
		(value): SourceTemplateImportReceipt["references"][number] => {
			const { templateKey, version, approvalKind, ...identity } = record(value);
			if (
				!isSourceTemplateKey(templateKey) ||
				version !== SOURCE_TEMPLATE_CONTRACT_VERSION ||
				(approvalKind !== "administrator-application" && approvalKind !== "test-fixture")
			)
				throw new Error("SOURCE_TEMPLATE_RECEIPT_INVALID");
			if (approvalKind === "test-fixture" && target.environment !== "local")
				throw new Error("SOURCE_TEMPLATE_FIXTURE_TARGET_FORBIDDEN");
			return {
				...sourceTemplateReferenceSchema.parse(identity),
				templateKey,
				version,
				approvalKind,
			};
		},
	);
	if (
		new Set(references.map((item) => `${item.templateKey}:${item.sourceUrl}`)).size !==
		references.length
	)
		throw new Error("SOURCE_TEMPLATE_DUPLICATE_REFERENCE_RECEIPT");
	return { schemaVersion: 1, target, references };
}

/** Re-evaluate dependent option sets after tier/preset selection; scenes do not multiply prices. */
export function enumerateSourceTemplatePriceOptions(
	templateKey: SourceTemplateKey,
): SourceTemplateChoices[] {
	let choices = [sourceTemplateDefaults(templateKey)];
	const dimensions = [
		["tier", "tiers"],
		["preset", "presets"],
		["durationSeconds", "durations"],
		["resolution", "resolutions"],
		["aspectRatio", "ratios"],
	] as const;
	for (const [key, set] of dimensions)
		choices = choices.flatMap((options) => {
			const values = sourceTemplateOptionSets(templateKey, options)[set];
			return values.length ? values.map((value) => ({ ...options, [key]: value })) : [options];
		});
	return choices;
}

export function resolvePreparedSourceRequest(
	templateKey: SourceTemplateKey,
	options: SourceTemplateChoices,
) {
	return resolveSourceTemplateRequest({
		templateKey,
		options,
		userImageUrls: sourceTemplateRoles(templateKey, options).map(
			(role) => `https://ezpic-template.example/user/${role}`,
		),
		configs: prepareArchivedSourceTemplateConfig(templateKey),
	});
}

export function sourceTemplateBundleHash(bundle: {
	schemaVersion: number;
	importReceipt: SourceTemplateImportReceipt | null;
	records: unknown;
}) {
	return createHash("sha256")
		.update(
			canonicalSourceTemplateJson({
				schemaVersion: bundle.schemaVersion,
				importReceipt: bundle.importReceipt,
				records: bundle.records,
			}),
		)
		.digest("hex");
}

/** Offline preparation only: hashes original bytes and binds supplied receipts, without approving them. */
export async function prepareSourceVideoTemplates(
	root: string,
	input: {
		environment?: Environment;
		receipt?: unknown;
		now?: Date;
	} = {},
) {
	const environment = input.environment ?? {};
	const now = input.now ?? new Date();
	if (!Number.isFinite(now.getTime())) throw new Error("SOURCE_TEMPLATE_CLOCK_INVALID");
	const importReceipt =
		input.receipt === undefined ? null : parseSourceTemplateImportReceipt(input.receipt);
	const materials = await Promise.all(
		archivedSourceMaterials.map(async (material) => {
			const bytes = await readFile(path.resolve(root, assetRoot, material.targetPath));
			if (
				bytes.byteLength !== material.bytes ||
				createHash("sha256").update(bytes).digest("hex") !== material.sha256
			)
				throw new Error("SOURCE_TEMPLATE_ARCHIVE_HASH_MISMATCH");
			return { ...material, localPath: path.posix.join(assetRoot, material.targetPath) };
		}),
	);
	const records = SOURCE_TEMPLATE_KEYS.map((templateKey) => {
		const options = sourceTemplateDefaults(templateKey);
		const sourceConfig = prepareArchivedSourceTemplateConfig(templateKey);
		const request = resolvePreparedSourceRequest(templateKey, options);
		const priceOptions = enumerateSourceTemplatePriceOptions(templateKey);
		const requests = priceOptions.map((choices) =>
			resolvePreparedSourceRequest(templateKey, choices),
		);
		if (templateKey === "spin-me-round")
			requests.push(
				resolvePreparedSourceRequest(templateKey, { ...options, sceneId: "retro-neon" }),
			);
		const requiredUrls = [...new Set(requests.flatMap((item) => item.requiredAssetUrls))].sort();
		const requiredMaterials = requiredUrls.map((url) => {
			const material = materials.find((item) => item.transportUrl === url);
			if (!material) throw new Error("SOURCE_TEMPLATE_ARCHIVE_BINDING_MISSING");
			return material;
		});
		const blockers = new Set<string>();
		if (!importReceipt) blockers.add("TARGET_REQUIRED");
		const receipts =
			importReceipt?.references.filter((item) => item.templateKey === templateKey) ?? [];
		if (receipts.some((item) => !requiredUrls.includes(item.sourceUrl)))
			throw new Error("SOURCE_TEMPLATE_UNEXPECTED_REFERENCE_RECEIPT");
		const references: Reference[] = [];
		for (const material of requiredMaterials) {
			const receipt = receipts.find((item) => item.sourceUrl === material.transportUrl);
			if (!receipt) {
				blockers.add(`TARGET_REFERENCE_REQUIRED:${material.sha256}`);
				continue;
			}
			if (receipt.checksum !== material.sha256)
				throw new Error("SOURCE_TEMPLATE_REFERENCE_HASH_MISMATCH");
			if (Date.parse(receipt.validUntil) <= now.getTime()) {
				blockers.add(`TARGET_REFERENCE_EXPIRED:${material.sha256}`);
				continue;
			}
			const { templateKey: _key, version: _version, approvalKind: _kind, ...reference } = receipt;
			references.push(reference);
		}
		const prices: ReturnType<typeof resolveSourceTemplatePrice>[] = [];
		for (let index = 0; index < priceOptions.length; index++) {
			try {
				prices.push(
					resolveSourceTemplatePrice(
						{ templateKey, options: priceOptions[index]!, transport: requests[index]! },
						environment,
					),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				if (
					/^(?:SOURCE_TEMPLATE_PRICE_[A-Z0-9_]+(?::[A-Z0-9_]+)?|VIDEO_(?:TEXT_)?MODERATION_NOT_CONFIGURED)$/.test(
						message,
					)
				)
					blockers.add(message);
				else throw error;
			}
		}
		if (
			new Set(prices.map((price) => canonicalSourceTemplateJson(price.options))).size !==
			prices.length
		)
			throw new Error("SOURCE_TEMPLATE_DUPLICATE_PRICE");
		return {
			templateKey,
			configKey: sourceTemplateConfigKey(templateKey),
			value: sourceTemplateProvisionSchema.parse({
				version: SOURCE_TEMPLATE_CONTRACT_VERSION,
				enabled: blockers.size === 0,
				access: blockers.size === 0 ? "authenticated" : "internal",
				sourceConfig,
				references,
				...encodeSourceTemplatePrices(prices),
			}),
			requiredMaterialHashes: requiredMaterials.map((material) => material.sha256),
			priceTupleCount: priceOptions.length,
			blockers: [...blockers].sort(),
			sourceContract: {
				revision: request.revision,
				provider: request.provider,
				modelId: request.modelId,
				output: request.output,
			},
		};
	});
	const bundle = { schemaVersion: 1 as const, importReceipt, records };
	return {
		...bundle,
		bundleHash: sourceTemplateBundleHash(bundle),
		status: records.every((item) => item.value.enabled)
			? ("READY_TO_APPLY" as const)
			: ("BLOCKED" as const),
		generationInvoked: false as const,
		databaseWritten: false as const,
		materials,
	};
}
export type PreparedSourceVideoTemplates = Awaited<ReturnType<typeof prepareSourceVideoTemplates>>;

export async function writePrivateSourceTemplateOutput(root: string, file: string, value: unknown) {
	const output = path.resolve(root, file);
	const relative = path.relative(root, output);
	if (
		!relative ||
		relative.startsWith("..") ||
		path.isAbsolute(relative) ||
		spawnSync("git", ["check-ignore", "--quiet", "--", relative], { cwd: root }).status !== 0 ||
		spawnSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: root }).status !== 1
	)
		throw new Error("SOURCE_TEMPLATE_OUTPUT_MUST_BE_PRIVATE");
	await mkdir(path.dirname(output), { recursive: true });
	await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
	return relative;
}
export async function readSourceTemplateEnvironment(file?: string): Promise<Environment> {
	if (!file) return { ...process.env };
	const input = record(JSON.parse(await readFile(file, "utf8")));
	if (Object.values(input).some((value) => typeof value !== "string"))
		throw new Error("SOURCE_TEMPLATE_ENVIRONMENT_INVALID");
	return { ...process.env, ...(input as Record<string, string>) };
}
async function main(args: string[]) {
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]!;
		if (
			!["--output", "--receipts", "--environment-file"].includes(key) ||
			options.has(key) ||
			!args[index + 1]
		)
			throw new Error("SOURCE_TEMPLATE_PREPARATION_ARGUMENTS_INVALID");
		options.set(key, args[index + 1]!);
	}
	if (!options.has("--output")) throw new Error("SOURCE_TEMPLATE_PREPARATION_ARGUMENTS_INVALID");
	const root = await realpath(process.cwd());
	const result = await prepareSourceVideoTemplates(root, {
		environment: await readSourceTemplateEnvironment(options.get("--environment-file")),
		receipt: options.has("--receipts")
			? JSON.parse(await readFile(options.get("--receipts")!, "utf8"))
			: undefined,
	});
	const output = await writePrivateSourceTemplateOutput(root, options.get("--output")!, result);
	process.stdout.write(
		`${JSON.stringify({
			status: result.status,
			templates: result.records.length,
			ready: result.records.filter((item) => item.value.enabled).length,
			priceTuples: result.records.reduce((sum, item) => sum + item.value.prices.length, 0),
			materials: result.materials.length,
			generationInvoked: false,
			databaseWritten: false,
			output,
		})}\n`,
	);
}
if (/(?:^|[\\/])prepare-source-video-templates\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
	void main(process.argv.slice(2)).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "";
		process.stderr.write(
			`${/^SOURCE_TEMPLATE_[A-Z0-9_]+$/.test(message) ? message : "SOURCE_TEMPLATE_PREPARATION_FAILED"}\n`,
		);
		process.exitCode = 1;
	});
}
