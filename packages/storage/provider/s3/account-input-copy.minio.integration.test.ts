import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
	AccountInputCopyClaim,
	AccountInputCopyDependencies,
} from "../../../jobs/src/contracts";
import { copyAccountInput } from "../../../jobs/src/handlers/account-input-copy";
import { createFinalAssetObjectKey } from "../../lib/object-key";

requireLocalMinio();
const originalEndpoint = process.env.S3_ENDPOINT!;
let proxy: Awaited<ReturnType<typeof createMinioProxy>>;
let storage: typeof import("./index");
type Location = { bucket: "media"; key: string };
const smallPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8L8AAAAASUVORK5CYII=",
	"base64",
);
let multipartPng: Buffer;

// This suite uses real MinIO HTTP, conditional MPU and full-byte verification.
// Only the database journal/lease/commit boundary is injected; it is not an ORM
// test, a real moderation decision, or evidence that a DB transaction committed.
describe("account input handler with real MinIO source-delete overlap", () => {
	beforeAll(async () => {
		proxy = await createMinioProxy(originalEndpoint);
		process.env.S3_ENDPOINT = proxy.url;
		storage = await import("./index");
		await storage.checkStorageMetadataAccess();
		multipartPng = await sharp({
			create: { width: 2048, height: 1536, channels: 3, background: "coral" },
		})
			.png({ compressionLevel: 0 })
			.toBuffer();
		expect(multipartPng.length).toBeGreaterThan(8 * 1024 * 1024);
	});

	afterAll(async () => {
		process.env.S3_ENDPOINT = originalEndpoint;
		await proxy?.close();
	});

	it.each(["small", "multipart"] as const)(
		"keeps the new %s target safe when the old source is deleted after MPU registration",
		async (size) => {
			const bytes = size === "small" ? smallPng : multipartPng;
			const registered = deferred();
			const completionReached = deferred();
			const resume = deferred();
			const journal = createJournal(bytes, async (uploadId) => {
				proxy.pauseCompletion(uploadId, completionReached.resolve, resume.promise);
				registered.resolve();
			});
			const source = location(journal.claim.source.objectKey);
			const target = location(journal.claim.target.objectKey);
			const deletedKeys: string[] = [];
			let operation:
				| Promise<PromiseSettledResult<Awaited<ReturnType<typeof copyAccountInput>>>>
				| undefined;
			try {
				await put(source, bytes);
				operation = settle(
					copyAccountInput({ promotionId: journal.claim.promotionId }, journal.dependencies),
				);
				await within(registered.promise);
				// The actual Complete request proves source streaming and all part writes
				// finished; pause it before it reaches MinIO, outside any database lock.
				await within(completionReached.promise);
				expect(journal.multipartIds).toHaveLength(1);
				expect(await storage.listMultipartUploads(target)).toContain(journal.multipartIds[0]);
				expect(await responseStatus(target)).toBe(404);
				deletedKeys.push(source.key);
				await storage.deleteObject(source);
				expect(await responseStatus(source)).toBe(404);
				resume.resolve();
				const result = await within(operation);
				if (result.status === "rejected") throw result.reason;
				expect(result.value).toEqual({ outcome: "VERIFYING" });
				expect(journal.phase).toBe("VERIFYING");
				expect(journal.materializations).toBe(1);
				const copiedBytes = await read(target);
				// Compare every byte without walking millions of Buffer properties and
				// blocking the event loop while the storage connection stays idle.
				expect(copiedBytes.equals(bytes)).toBe(true);
				expect(sha256(copiedBytes)).toBe(journal.claim.source.checksum);
				// ETag only shows actual MinIO part count, never SHA/content identity.
				expect((await storage.headObject(target)).etag).toMatch(
					size === "small" ? /-1"?$/ : /-2"?$/,
				);
				// A replay of the old physical cleanup still names the source only.
				deletedKeys.push(source.key);
				await storage.deleteObject(source);
				expect(deletedKeys).toEqual([source.key, source.key]);
				expect(deletedKeys).not.toContain(target.key);
				expect(sha256(await read(target))).toBe(sha256(bytes));
				expect(journal.copyTargets).toEqual([target.key]);
				expect(journal.phase).not.toBe("READY");
			} finally {
				resume.resolve();
				if (operation) await within(operation);
				await cleanup(source, target);
			}
		},
		120_000,
	);

	it.each(["small", "multipart"] as const)(
		"recovers the same verified %s key after a lost DB response and physical source deletion",
		async (size) => {
			const bytes = size === "small" ? smallPng : multipartPng;
			const journal = createJournal(bytes, undefined, true);
			const source = location(journal.claim.source.objectKey);
			const target = location(journal.claim.target.objectKey);
			try {
				await put(source, bytes);
				await expect(
					copyAccountInput({ promotionId: journal.claim.promotionId }, journal.dependencies),
				).rejects.toThrow("DB_RESPONSE_LOST");
				expect(journal.phase).toBe("PENDING");
				expect(journal.materializations).toBe(0);
				const copiedBytes = await read(target);
				expect(copiedBytes.equals(bytes)).toBe(true);
				expect(sha256(copiedBytes)).toBe(journal.claim.source.checksum);
				const before = await storage.headObject(target);
				await storage.deleteObject(source);
				expect(await responseStatus(source)).toBe(404);
				const sourceReadsBeforeRecovery = proxy.requests.filter(
					(request) => request.method === "GET" && request.key === source.key,
				).length;
				await expect(
					copyAccountInput({ promotionId: journal.claim.promotionId }, journal.dependencies),
				).resolves.toEqual({ outcome: "VERIFYING" });
				expect(journal.copyTargets).toEqual([target.key, target.key]);
				expect(journal.multipartIds).toHaveLength(1);
				expect(
					proxy.requests.filter(
						(request) => request.method === "POST" && request.create && request.key === target.key,
					),
				).toHaveLength(1);
				expect(
					proxy.requests.filter(
						(request) => request.method === "GET" && request.key === source.key,
					),
				).toHaveLength(sourceReadsBeforeRecovery);
				expect(journal.materializations).toBe(1);
				expect(journal.phase).toBe("VERIFYING");
				const recoveredBytes = await read(target);
				expect(recoveredBytes.equals(bytes)).toBe(true);
				expect(sha256(recoveredBytes)).toBe(journal.claim.source.checksum);
				expect((await storage.headObject(target)).etag).toBe(before.etag);
				expect(await storage.listMultipartUploads(target)).toEqual([]);
				await storage.deleteObject(source);
				const retainedBytes = await read(target);
				expect(retainedBytes.equals(bytes)).toBe(true);
				expect(sha256(retainedBytes)).toBe(journal.claim.source.checksum);
			} finally {
				await cleanup(source, target);
			}
		},
		120_000,
	);

	it("skips a committed copy after its response is lost without another storage write", async () => {
		const journal = createJournal(smallPng);
		const source = location(journal.claim.source.objectKey);
		const target = location(journal.claim.target.objectKey);
		const commit = journal.dependencies.commit;
		journal.dependencies.commit = async (input) => {
			await commit(input);
			throw new Error("DB_RESPONSE_LOST");
		};
		try {
			await put(source, smallPng);
			await expect(
				copyAccountInput({ promotionId: journal.claim.promotionId }, journal.dependencies),
			).rejects.toThrow("DB_RESPONSE_LOST");
			expect(journal.phase).toBe("VERIFYING");
			expect(journal.materializations).toBe(1);
			await storage.deleteObject(source);
			const requestsBeforeReplay = proxy.requests.length;
			await expect(
				copyAccountInput({ promotionId: journal.claim.promotionId }, journal.dependencies),
			).resolves.toEqual({ outcome: "SKIPPED" });
			expect(proxy.requests).toHaveLength(requestsBeforeReplay);
			expect(journal.copyTargets).toEqual([target.key]);
			expect(journal.materializations).toBe(1);
			expect(sha256(await read(target))).toBe(journal.claim.source.checksum);
			expect(await responseStatus(source)).toBe(404);
		} finally {
			await cleanup(source, target);
		}
	});
});

function createJournal(
	bytes: Buffer,
	pauseAfterRegistration?: (uploadId: string) => Promise<void>,
	loseFirstCommitResponse = false,
) {
	const id = randomUUID().replaceAll("-", "");
	const claim: AccountInputCopyClaim = {
		promotionId: `minio-copy-${id}`,
		leaseToken: "unclaimed",
		source: {
			assetId: `guest_${id}`,
			objectKey: createFinalAssetObjectKey(
				`copy_guest_${id}`,
				`guest_${id}`,
				"original",
				"image/png",
			),
			checksum: sha256(bytes),
			bytes: bytes.length,
			mimeType: "image/png",
		},
		target: {
			ownerId: `copy_account_${id}`,
			assetId: `account_${id}`,
			objectKey: createFinalAssetObjectKey(
				`copy_account_${id}`,
				`account_${id}`,
				"copy",
				"image/png",
			),
		},
	};
	let phase: "PENDING" | "COPYING" | "VERIFYING" | "FAILED" = "PENDING";
	let lease = 0,
		multipartUploadId: string | undefined,
		materializations = 0;
	const multipartIds: string[] = [],
		copyTargets: string[] = [];
	const current = (token: string) => {
		if (phase !== "COPYING" || token !== `lease-${lease}`)
			throw new Error("ACCOUNT_INPUT_COPY_LEASE_LOST");
	};
	const dependencies: AccountInputCopyDependencies = {
		claim: async ({ promotionId }) => {
			expect(promotionId).toBe(claim.promotionId);
			if (phase === "VERIFYING" || phase === "FAILED") return null;
			phase = "COPYING";
			lease++;
			return {
				...structuredClone(claim),
				leaseToken: `lease-${lease}`,
				...(multipartUploadId ? { multipartUploadId } : {}),
			};
		},
		registerMultipart: async (input) => {
			current(input.leaseToken);
			multipartUploadId = input.multipartUploadId;
			multipartIds.push(input.multipartUploadId);
			await pauseAfterRegistration?.(input.multipartUploadId);
		},
		clearMultipart: async (input) => {
			current(input.leaseToken);
			expect(input.multipartUploadId).toBe(multipartUploadId);
			multipartUploadId = undefined;
		},
		copy: async (input) => {
			expect(input.staging.key).toBe(claim.source.objectKey);
			expect(input.expectedSha256).toBe(claim.source.checksum);
			expect(input.acceptExistingFinalIdentity).toBe(false);
			copyTargets.push(input.final.key);
			return storage.promoteStagedObject(input);
		},
		commit: async (input) => {
			current(input.leaseToken);
			expect(input).toMatchObject({
				promotionId: claim.promotionId,
				checksum: claim.source.checksum,
				bytes: bytes.length,
				mimeType: "image/png",
			});
			if (loseFirstCommitResponse) {
				loseFirstCommitResponse = false;
				throw new Error("DB_RESPONSE_LOST");
			}
			materializations++;
			phase = "VERIFYING";
		},
		fail: async (input) => {
			current(input.leaseToken);
			phase = input.definitive ? "FAILED" : "PENDING";
		},
	};
	return {
		claim,
		dependencies,
		multipartIds,
		copyTargets,
		get phase(): string {
			return phase;
		},
		get materializations() {
			return materializations;
		},
	};
}

function requireLocalMinio() {
	const missing = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter(
		(key) => !process.env[key],
	);
	if (missing.length) throw new Error(`MINIO_INTEGRATION_ENV_MISSING: ${missing.join(", ")}`);
	const endpoint = new URL(process.env.S3_ENDPOINT!);
	if (
		endpoint.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		endpoint.pathname !== "/"
	)
		throw new Error("LOCAL_MINIO_REQUIRED");
}
function location(key: string): Location {
	return { bucket: "media", key };
}
function sha256(body: Buffer) {
	return createHash("sha256").update(body).digest("hex");
}
async function put(target: Location, body: Buffer) {
	const url = await storage.createSignedUpload({
		...target,
		contentType: "image/png",
		contentLength: body.length,
	});
	const response = await fetch(url, {
		method: "PUT",
		headers: { "Content-Type": "image/png" },
		body: Uint8Array.from(body).buffer,
	});
	expect(response.ok).toBe(true);
}
async function responseStatus(target: Location) {
	const response = await fetch(await storage.createSignedReadUrl(target));
	await response.body?.cancel();
	return response.status;
}
async function read(target: Location) {
	const response = await fetch(await storage.createSignedReadUrl(target));
	if (!response.ok) throw new Error(`OBJECT_READ_FAILED:${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}
async function cleanup(...targets: Location[]) {
	for (const target of targets) {
		for (const uploadId of await storage.listMultipartUploads(target))
			await storage.abortMultipartUpload({ ...target, uploadId });
		await storage.deleteObject(target);
	}
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("MINIO_TEST_BOUNDARY_TIMEOUT")), 15_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
	return promise.then(
		(value) => ({ status: "fulfilled", value }),
		(reason: unknown) => ({ status: "rejected", reason }),
	);
}
/** Transparent local HTTP transport: only Complete can be paused. All storage
 * responses, condition checks and bytes still come from the pinned MinIO server.
 * Preserve Host because S3 authorization signs the original proxy authority. */
async function createMinioProxy(endpoint: string) {
	const upstream = new URL(endpoint);
	const completions = new Map<string, { arrived(): void; resume: Promise<void> }>();
	const requests: Array<{ method: string; key: string; create: boolean }> = [];
	const server = createServer(async (incoming, outgoing) => {
		const parsed = new URL(incoming.url ?? "/", "http://localhost");
		const key = decodeURIComponent(parsed.pathname).split("/").slice(2).join("/");
		requests.push({
			method: incoming.method ?? "GET",
			key,
			create: parsed.searchParams.has("uploads"),
		});
		const uploadId = parsed.searchParams.get("uploadId");
		const checkpoint =
			incoming.method === "POST" && uploadId ? completions.get(uploadId) : undefined;
		if (checkpoint) {
			checkpoint.arrived();
			await checkpoint.resume;
			completions.delete(uploadId!);
		}
		const forwarded = httpRequest(
			{
				hostname: upstream.hostname,
				port: upstream.port,
				path: incoming.url,
				method: incoming.method,
				headers: incoming.headers,
			},
			(response) => {
				outgoing.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(outgoing);
			},
		);
		forwarded.on("error", () => {
			outgoing.writeHead(502);
			outgoing.end();
		});
		incoming.on("aborted", () => forwarded.destroy());
		incoming.pipe(forwarded);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("MINIO_PROXY_BIND_FAILED");
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		pauseCompletion(uploadId: string, arrived: () => void, resume: Promise<void>) {
			completions.set(uploadId, { arrived, resume });
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
