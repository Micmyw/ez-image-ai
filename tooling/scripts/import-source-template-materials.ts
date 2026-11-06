import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	archivedSourceMaterials,
	prepareArchivedSourceTemplateConfig,
} from "../../packages/ai/media/rap-templates/archive";
import { resolveSourceTemplateRequest } from "../../packages/ai/media/rap-templates/contracts";
import manifest from "../../packages/ai/media/rap-templates/source-manifest.json";
import { SOURCE_TEMPLATE_CONTRACT_VERSION } from "../../packages/config/video-template-execution.server";
import {
	sourceTemplateDefaults,
	sourceTemplateRoles,
} from "../../packages/config/video-template-library";
import {
	sourceMaterialImportApprovalSchema,
	sourceMaterialImportTargetSchema,
	reserveSourceTemplateMaterial,
	commitSourceTemplateMaterial,
	type SourceMaterialImportApproval,
	type SourceMaterialImportTarget,
} from "../../packages/database/prisma/queries/media/source-template-material-import";
import type { MediaTransactionClient } from "../../packages/database/prisma/queries/media/types";
import type {
	SourceMaterialWrite,
	SourceMaterialStorageReceipt,
} from "../../packages/storage/provider/s3/source-template-material";

export { sourceMaterialImportTargetSchema };
export function assertSourceMaterialImportTarget(
	targetValue: SourceMaterialImportTarget,
	env = process.env,
) {
	const target = sourceMaterialImportTargetSchema.parse(targetValue);
	const db = new URL(env.DATABASE_URL ?? "");
	const endpoint = new URL(env.S3_ENDPOINT ?? "");
	if (
		!["postgres:", "postgresql:"].includes(db.protocol) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		target.databaseIdentity !== `postgresql://${db.host}${db.pathname}` ||
		target.storageEndpoint !== endpoint.href ||
		target.bucket !== env.MEDIA_BUCKET_NAME ||
		(target.environment === "local" &&
			![db.hostname, endpoint.hostname].every((host) =>
				["localhost", "127.0.0.1", "[::1]"].includes(host),
			))
	)
		throw new Error("SOURCE_TEMPLATE_TARGET_MISMATCH");
	return target;
}

function materialForApproval(approval: SourceMaterialImportApproval) {
	if (approval.version !== SOURCE_TEMPLATE_CONTRACT_VERSION)
		throw new Error("SOURCE_TEMPLATE_VERSION_MISMATCH");
	const material = archivedSourceMaterials.find(
		(item) => item.transportUrl === approval.sourceUrl && item.sha256 === approval.checksum,
	);
	const provenance = approval.sourceProvenance;
	if (
		!material ||
		material.bytes !== approval.bytes ||
		material.mimeType !== approval.mimeType ||
		provenance.sourceCommit !== manifest.sourceCommit ||
		provenance.sourceConfigKey !== material.sourceConfigKey ||
		provenance.sourceRole !== material.role ||
		provenance.sourceRevision !== material.revision ||
		provenance.sourceUrlSha256 !== material.sourceUrlSha256 ||
		provenance.sourceAssetSha256 !== material.sha256
	)
		throw new Error("SOURCE_TEMPLATE_ARCHIVE_BINDING_MISMATCH");
	const defaults = sourceTemplateDefaults(approval.templateKey);
	const choices =
		approval.templateKey === "spin-me-round"
			? (["empty-room", "retro-neon"] as const).map((sceneId) => ({ ...defaults, sceneId }))
			: [defaults];
	const urls = choices.flatMap(
		(options) =>
			resolveSourceTemplateRequest({
				templateKey: approval.templateKey,
				options,
				userImageUrls: sourceTemplateRoles(approval.templateKey, options).map(
					(role) => `https://ezpic-template.example/user/${role}`,
				),
				configs: prepareArchivedSourceTemplateConfig(approval.templateKey),
			}).requiredAssetUrls,
	);
	if (!urls.includes(material.transportUrl))
		throw new Error("SOURCE_TEMPLATE_ARCHIVE_ROLE_MISMATCH");
	return material;
}

export type SourceMaterialImportDependencies = {
	database: MediaTransactionClient;
	write(input: SourceMaterialWrite): Promise<SourceMaterialStorageReceipt>;
};
async function readOriginal(file: string, expectedBytes: number, sha256: string) {
	if (expectedBytes <= 0 || expectedBytes > 25 * 1024 * 1024)
		throw new Error("SOURCE_TEMPLATE_ARCHIVE_HASH_MISMATCH");
	const body = Buffer.allocUnsafe(expectedBytes);
	let bytes = 0;
	for await (const chunk of createReadStream(file)) {
		const part = chunk as Buffer;
		bytes += part.byteLength;
		if (bytes > expectedBytes) throw new Error("SOURCE_TEMPLATE_ARCHIVE_HASH_MISMATCH");
		body.set(part, bytes - part.byteLength);
	}
	if (bytes !== expectedBytes || createHash("sha256").update(body).digest("hex") !== sha256)
		throw new Error("SOURCE_TEMPLATE_ARCHIVE_HASH_MISMATCH");
	return body;
}
/** Dry-run hashes originals only. Apply uses explicit target/admin approval; no generation/review API. */
export async function importSourceTemplateMaterials(
	input: {
		root: string;
		target: SourceMaterialImportTarget;
		approvals: unknown;
		maximumBytes: bigint;
		apply: boolean;
	},
	dependencies?: SourceMaterialImportDependencies,
) {
	const target = sourceMaterialImportTargetSchema.parse(input.target);
	const approvals = sourceMaterialImportApprovalSchema
		.array()
		.min(1)
		.max(100)
		.parse(input.approvals);
	if (
		approvals.some(
			(item) =>
				item.targetEnvironment !== target.environment ||
				(item.approvalKind === "test-fixture" && target.environment !== "local"),
		)
	)
		throw new Error("SOURCE_TEMPLATE_TARGET_MISMATCH");
	if (input.maximumBytes <= 0n) throw new Error("SOURCE_TEMPLATE_QUOTA_REQUIRED");
	if (
		new Set(approvals.map((item) => `${item.templateKey}:${item.sourceUrl}`)).size !==
		approvals.length
	)
		throw new Error("SOURCE_TEMPLATE_DUPLICATE_MATERIAL_APPROVAL");
	const root = await realpath(input.root);
	const assetRoot = await realpath(
		path.join(root, "packages/ai/media/rap-templates/private-assets"),
	);
	// Validate every receipt and hash before the first write; keep only one bounded buffer during upload.
	const files = [];
	for (const approval of approvals) {
		const material = materialForApproval(approval);
		const file = await realpath(
			path.join(root, "packages/ai/media/rap-templates", material.targetPath),
		);
		const relative = path.relative(assetRoot, file);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
			throw new Error("SOURCE_TEMPLATE_ARCHIVE_PATH_INVALID");
		await readOriginal(file, material.bytes, material.sha256);
		files.push({ file, approval });
	}
	const totalBytes = files.reduce((sum, item) => sum + item.approval.bytes, 0);
	if (BigInt(totalBytes) > input.maximumBytes) throw new Error("STORAGE_QUOTA_EXCEEDED");
	if (!input.apply)
		return {
			schemaVersion: 1 as const,
			target,
			status: "DRY_RUN" as const,
			materials: files.length,
			bytes: totalBytes,
			references: [],
			generationInvoked: false,
			databaseWritten: false,
		};
	assertSourceMaterialImportTarget(target);
	if (!dependencies) throw new Error("SOURCE_TEMPLATE_IMPORT_DEPENDENCIES_REQUIRED");
	const references = [];
	for (const { file, approval } of files) {
		const reserved = await reserveSourceTemplateMaterial(
			approval,
			input.maximumBytes,
			dependencies.database,
		);
		const body = await readOriginal(file, approval.bytes, approval.checksum);
		// Storage repeats the hash check after this read, closing a local-file replacement race.
		const stored = await dependencies.write({
			ownerId: approval.ownerId,
			key: reserved.objectKey,
			body,
			bytes: approval.bytes,
			sha256: approval.checksum,
			contentType: approval.mimeType,
		});
		references.push(await commitSourceTemplateMaterial(approval, stored, dependencies.database));
	}
	return {
		schemaVersion: 1 as const,
		target,
		status: "IMPORTED" as const,
		materials: files.length,
		bytes: totalBytes,
		references,
		generationInvoked: false,
		databaseWritten: true,
	};
}

async function main(args: string[]) {
	const options = new Map<string, string>();
	let apply = false;
	for (let index = 0; index < args.length; index++) {
		const key = args[index]!;
		if (key === "--apply") {
			if (apply) throw new Error("SOURCE_TEMPLATE_ARGUMENTS_INVALID");
			apply = true;
			continue;
		}
		if (
			!["--receipts", "--output", "--maximum-bytes"].includes(key) ||
			options.has(key) ||
			!args[index + 1]
		)
			throw new Error("SOURCE_TEMPLATE_ARGUMENTS_INVALID");
		options.set(key, args[++index]!);
	}
	if (options.size !== 3 || !/^[1-9][0-9]*$/.test(options.get("--maximum-bytes")!))
		throw new Error("SOURCE_TEMPLATE_ARGUMENTS_INVALID");
	const root = await realpath(process.cwd());
	const output = path.resolve(root, options.get("--output")!);
	const relative = path.relative(root, output);
	if (
		!relative ||
		relative.startsWith("..") ||
		path.isAbsolute(relative) ||
		spawnSync("git", ["check-ignore", "--quiet", "--", relative], { cwd: root }).status !== 0 ||
		spawnSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: root }).status !== 1
	)
		throw new Error("SOURCE_TEMPLATE_OUTPUT_MUST_BE_PRIVATE");
	const receipts = JSON.parse(await readFile(options.get("--receipts")!, "utf8")) as {
		target: SourceMaterialImportTarget;
		approvals: unknown;
	};
	const target = sourceMaterialImportTargetSchema.parse(receipts.target);
	let database: MediaTransactionClient | undefined;
	let storage:
		| ReturnType<
				typeof import("../../packages/storage/provider/s3/source-template-material").createSourceMaterialStorage
		  >
		| undefined;
	try {
		if (apply) {
			assertSourceMaterialImportTarget(target);
			if (!process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY)
				throw new Error("SOURCE_TEMPLATE_STORAGE_CREDENTIALS_REQUIRED");
			const { createRuntimeDatabaseClient } = await import("../../packages/database/prisma/client");
			const { createSourceMaterialStorage } =
				await import("../../packages/storage/provider/s3/source-template-material");
			database = createRuntimeDatabaseClient(process.env.DATABASE_URL!);
			storage = createSourceMaterialStorage({
				endpoint: target.storageEndpoint,
				bucket: target.bucket,
				region: process.env.S3_REGION ?? "auto",
				accessKeyId: process.env.S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
			});
		}
		const result = await importSourceTemplateMaterials(
			{
				root,
				target,
				approvals: receipts.approvals,
				maximumBytes: BigInt(options.get("--maximum-bytes")!),
				apply,
			},
			database && storage ? { database, write: (value) => storage!.write(value) } : undefined,
		);
		await mkdir(path.dirname(output), { recursive: true });
		await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
		process.stdout.write(
			`${JSON.stringify({ status: result.status, materials: result.materials, bytes: result.bytes, generationInvoked: false, output: relative })}\n`,
		);
	} finally {
		storage?.close();
		await database?.$disconnect();
	}
}
if (/(?:^|[\\/])import-source-template-materials\.(?:ts|js)$/.test(process.argv[1] ?? "")) {
	void main(process.argv.slice(2)).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "";
		process.stderr.write(
			`${/^(SOURCE_TEMPLATE_[A-Z0-9_]+|STORAGE_QUOTA_EXCEEDED)$/.test(message) ? message : "SOURCE_TEMPLATE_IMPORT_FAILED"}\n`,
		);
		process.exitCode = 1;
	});
}
