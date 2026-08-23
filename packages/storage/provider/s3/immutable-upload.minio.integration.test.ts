import { createHash, randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { createFinalAssetObjectKey, createStagingObjectKey } from "../../lib/object-key";

const mediaBucket = process.env.MEDIA_BUCKET_NAME ?? "media-private";
const contentType = "image/png" as const;

requireMinioEnvironment();

let storage: typeof import("./index");

describe("immutable staging upload promotion (MinIO)", () => {
	beforeAll(async () => {
		// Import after validating the supplied environment: storage config captures the
		// configured bucket during module initialization.
		storage = await import("./index");
		const { config } = await import("../../config");
		expect(config.bucketNames.media).toBe(mediaBucket);
		await storage.checkStorageMetadataAccess();
	});

	it("keeps final bytes unchanged when an unexpired staging PUT URL is replayed", async () => {
		const id = randomUUID();
		const staging = location("staging", id);
		const final = location("final", id);
		const approved = pngPayload(64);
		const replacement = Buffer.from(approved);
		replacement[32] = 0xff;

		try {
			const putUrl = await storage.createSignedUpload({
				...staging,
				contentType,
				contentLength: approved.byteLength,
			});
			expect(await putSignedObject(putUrl, approved)).toBe(true);

			const promoted = await storage.promoteStagedObject({
				staging,
				final,
				contentType,
				contentLength: approved.byteLength,
			});
			expect(promoted.sha256).toBe(sha256(approved));

			expect(await putSignedObject(putUrl, replacement)).toBe(true);
			await expect(readObject(staging)).resolves.toEqual(replacement);
			await expect(readObject(final)).resolves.toEqual(approved);
		} finally {
			await deleteLocations(staging, final);
		}
	});

	it("signs staging multipart parts, converges concurrent promotions, and cleans only staging", async () => {
		const id = randomUUID();
		const firstStaging = location("staging", `${id}-first`);
		const secondStaging = location("staging", `${id}-second`);
		const final = location("final", id);
		const body = pngPayload(5 * 1024 * 1024);
		let firstStagingUploadId: string | undefined;
		let secondStagingUploadId: string | undefined;

		try {
			const firstStagingUpload = await completeStagingMultipart(firstStaging, body, final);
			firstStagingUploadId = firstStagingUpload.uploadId;
			const secondStagingUpload = await completeStagingMultipart(secondStaging, body, final);
			secondStagingUploadId = secondStagingUpload.uploadId;

			// Both callers receive the same immutable final result. The explicit conditional
			// write collision is covered below because scheduler timing can let either caller
			// inspect the completed final before it tries to write.
			const [firstRecovery, secondRecovery] = await Promise.all([
				storage.promoteStagedObject({
					staging: firstStaging,
					final,
					contentType,
					contentLength: body.byteLength,
				}),
				storage.promoteStagedObject({
					staging: secondStaging,
					final,
					contentType,
					contentLength: body.byteLength,
				}),
			]);
			expect(firstRecovery.sha256).toBe(sha256(body));
			expect(secondRecovery.sha256).toBe(sha256(body));
			expect(firstRecovery.bytes).toBe(body.byteLength);
			expect(secondRecovery.bytes).toBe(body.byteLength);
			await expect(readObject(final)).resolves.toEqual(body);

			// The database integration test proves this delete is scheduled at the upload
			// URL's expiry. Here, perform that physical cleanup and show it cannot remove
			// or overwrite the immutable final object.
			await expect(readObject(firstStaging)).resolves.toEqual(body);
			await storage.deleteObject(firstStaging);
			await expect(readObject(firstStaging)).rejects.toThrow(/404/);
			await expect(readObject(final)).resolves.toEqual(body);
		} finally {
			await Promise.all([
				firstStagingUploadId
					? storage
							.abortMultipartUpload({ ...firstStaging, uploadId: firstStagingUploadId })
							.catch(() => undefined)
					: undefined,
				secondStagingUploadId
					? storage
							.abortMultipartUpload({ ...secondStaging, uploadId: secondStagingUploadId })
							.catch(() => undefined)
					: undefined,
			]);
			await deleteLocations(firstStaging, secondStaging, final);
		}
	}, 60_000);

	it("permits exactly one conditional final multipart completion and retries by inspecting the stored final", async () => {
		const id = randomUUID();
		const staging = location("staging", `${id}-retry`);
		const final = location("final", `${id}-conditional`);
		const body = pngPayload(64);
		const finalUploadIds: string[] = [];

		try {
			const stagingPutUrl = await storage.createSignedUpload({
				...staging,
				contentType,
				contentLength: body.byteLength,
			});
			expect(await putSignedObject(stagingPutUrl, body)).toBe(true);

			const candidates = await Promise.all(
				[0, 1].map(async () => {
					const { uploadId } = await storage.createMultipartUpload({ ...final, contentType });
					finalUploadIds.push(uploadId);
					const etag = await storage.uploadMultipartPart({
						...final,
						uploadId,
						partNumber: 1,
						body,
					});
					return { uploadId, parts: [{ partNumber: 1, etag }] };
				}),
			);
			const completed = await Promise.allSettled(
				candidates.map(({ uploadId, parts }) =>
					storage.completeMultipartUpload({ ...final, uploadId, parts, ifNoneMatch: "*" }),
				),
			);
			const fulfilled = completed.filter(
				(result): result is PromiseFulfilledResult<void> => result.status === "fulfilled",
			);
			const rejected = completed.filter(
				(result): result is PromiseRejectedResult => result.status === "rejected",
			);
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect(isConditionalWriteConflict(rejected[0]!.reason)).toBe(true);

			const recovered = await storage.promoteStagedObject({
				staging,
				final,
				contentType,
				contentLength: body.byteLength,
			});
			const replayed = await storage.promoteStagedObject({
				staging,
				final,
				contentType,
				contentLength: body.byteLength,
			});
			expect(recovered.sha256).toBe(sha256(body));
			expect(replayed.sha256).toBe(sha256(body));
			await expect(readObject(final)).resolves.toEqual(body);
		} finally {
			await Promise.all(
				finalUploadIds.map((uploadId) =>
					storage.abortMultipartUpload({ ...final, uploadId }).catch(() => undefined),
				),
			);
			await deleteLocations(staging, final);
		}
	});
});

async function completeStagingMultipart(
	staging: { bucket: "media"; key: string },
	body: Buffer,
	final: { bucket: "media"; key: string },
): Promise<{ uploadId: string }> {
	const { uploadId } = await storage.createMultipartUpload({ ...staging, contentType });
	const signedPartUrl = await storage.signMultipartPart({
		...staging,
		uploadId,
		partNumber: 1,
		contentLength: body.byteLength,
	});
	const signedPath = decodeURIComponent(new URL(signedPartUrl).pathname);
	expect(signedPath).toContain(staging.key);
	expect(signedPath).not.toContain(final.key);
	const stagedPart = await putSignedPart(signedPartUrl, body);
	await storage.completeMultipartUpload({ ...staging, uploadId, parts: [stagedPart] });
	return { uploadId };
}

function requireMinioEnvironment(): void {
	const missing = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter(
		(name) => !process.env[name],
	);
	if (missing.length > 0) {
		throw new Error(`MINIO_INTEGRATION_ENV_MISSING: ${missing.join(", ")}`);
	}
}

function location(kind: "staging" | "final", id: string): { bucket: "media"; key: string } {
	const value = id.replaceAll("-", "");
	const ownerId = `user_${value}`;
	return {
		bucket: "media",
		key:
			kind === "staging"
				? createStagingObjectKey(ownerId, `session_${value}`, "nonce", contentType)
				: createFinalAssetObjectKey(ownerId, `asset_${value}`, "version", contentType),
	};
}

function pngPayload(length: number): Buffer {
	const body = Buffer.alloc(length);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
	return body;
}

async function putSignedObject(url: string, body: Buffer): Promise<boolean> {
	const response = await fetch(url, {
		method: "PUT",
		headers: { "content-type": contentType },
		body: fetchBody(body),
	});
	return response.ok;
}

async function putSignedPart(
	url: string,
	body: Buffer,
): Promise<{ partNumber: number; etag: string }> {
	const response = await fetch(url, {
		method: "PUT",
		headers: { "content-type": contentType },
		body: fetchBody(body),
	});
	expect(response.ok).toBe(true);
	const etag = response.headers.get("etag");
	if (!etag) throw new Error("MinIO multipart response omitted ETag");
	return { partNumber: 1, etag };
}

async function readObject(location_: { bucket: "media"; key: string }): Promise<Buffer> {
	const url = await storage.createSignedReadUrl(location_);
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Expected readable object, received ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

async function deleteLocations(
	...locations: Array<{ bucket: "media"; key: string }>
): Promise<void> {
	await Promise.all(
		locations.map((location_) => storage.deleteObject(location_).catch(() => undefined)),
	);
}

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function isConditionalWriteConflict(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const details = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
	return (
		details.name === "PreconditionFailed" ||
		details.name === "ConditionalRequestConflict" ||
		details.$metadata?.httpStatusCode === 409 ||
		details.$metadata?.httpStatusCode === 412
	);
}

function fetchBody(body: Buffer): ArrayBuffer {
	return Uint8Array.from(body).buffer;
}
