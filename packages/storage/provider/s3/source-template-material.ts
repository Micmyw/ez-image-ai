import { createHash } from "node:crypto";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { assertDetectedMediaType } from "../../lib/media-signatures";

export type SourceMaterialWrite = {
	ownerId: string;
	key: string;
	body: Buffer;
	bytes: number;
	sha256: string;
	contentType: "image/jpeg" | "image/png" | "image/webp" | "audio/wav";
};
export type SourceMaterialStorageReceipt = {
	bytes: number;
	sha256: string;
	etag: string;
	versionId: string | null;
};

/** Original bytes only. No transformations, public ACL, overwrite, or provider generation. */
export function createSourceMaterialStorage(input: {
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
}) {
	const client = new S3Client({
		endpoint: input.endpoint,
		region: input.region,
		forcePathStyle: true,
		maxAttempts: 1,
		credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
	});
	return {
		close: () => client.destroy(),
		async write(value: SourceMaterialWrite): Promise<SourceMaterialStorageReceipt> {
			if (
				!/^[a-zA-Z0-9_-]{1,160}$/.test(value.ownerId) ||
				!value.key.startsWith(`users/${value.ownerId}/source-templates/`) ||
				!/^users\/[a-zA-Z0-9_-]+\/source-templates\/[a-f0-9]{64}$/.test(value.key) ||
				value.bytes <= 0 ||
				value.bytes > 25 * 1024 * 1024 ||
				value.body.byteLength !== value.bytes ||
				createHash("sha256").update(value.body).digest("hex") !== value.sha256
			)
				throw new Error("SOURCE_TEMPLATE_STORAGE_INPUT_INVALID");
			if (value.contentType === "audio/wav") {
				if (
					value.body.toString("ascii", 0, 4) !== "RIFF" ||
					value.body.toString("ascii", 8, 12) !== "WAVE"
				)
					throw new Error("SOURCE_TEMPLATE_STORAGE_INPUT_INVALID");
			} else assertDetectedMediaType(value.body.subarray(0, 64), value.contentType);
			const location = { Bucket: input.bucket, Key: value.key };
			const inspect = async () => {
				const result = await client.send(new GetObjectCommand(location));
				if (!result.Body) throw new Error("SOURCE_TEMPLATE_STORAGE_IDENTITY_MISMATCH");
				const reader = result.Body.transformToWebStream().getReader();
				const hash = createHash("sha256");
				let bytes = 0;
				try {
					if (
						!result.ETag ||
						result.ContentLength !== value.bytes ||
						result.ContentType !== value.contentType
					)
						throw new Error("SOURCE_TEMPLATE_STORAGE_IDENTITY_MISMATCH");
					for (;;) {
						const part = await reader.read();
						if (part.done) break;
						bytes += part.value.byteLength;
						if (bytes > value.bytes) throw new Error("SOURCE_TEMPLATE_STORAGE_IDENTITY_MISMATCH");
						hash.update(part.value);
					}
				} finally {
					await reader.cancel().catch(() => undefined);
					reader.releaseLock();
				}
				const sha256 = hash.digest("hex");
				if (bytes !== value.bytes || sha256 !== value.sha256)
					throw new Error("SOURCE_TEMPLATE_STORAGE_IDENTITY_MISMATCH");
				return { bytes, sha256, etag: result.ETag!, versionId: result.VersionId ?? null };
			};
			try {
				return await inspect();
			} catch (error) {
				if (
					(error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404
				)
					throw error;
			}
			try {
				await client.send(
					new PutObjectCommand({
						...location,
						Body: value.body,
						ContentLength: value.bytes,
						ContentType: value.contentType,
						Metadata: { sha256: value.sha256 },
						IfNoneMatch: "*",
					}),
				);
			} catch (error) {
				// Only an explicit conditional conflict permits retrieval; unknown writes never retransmit here.
				if (
					![409, 412].includes(
						(error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0,
					)
				)
					throw error;
			}
			return inspect();
		},
	};
}
