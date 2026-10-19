import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => {
	process.env.S3_ENDPOINT = "http://storage.test";
	process.env.S3_ACCESS_KEY_ID = "test-only-access";
	process.env.S3_SECRET_ACCESS_KEY = "test-only-secret";
	process.env.MEDIA_BUCKET_NAME = "account-copy-test";
	return { send: vi.fn() };
});
vi.mock("@aws-sdk/client-s3", () => {
	class Command {
		constructor(readonly input: Record<string, unknown>) {}
	}
	return {
		AbortMultipartUploadCommand: class AbortMultipartUploadCommand extends Command {},
		CompleteMultipartUploadCommand: class CompleteMultipartUploadCommand extends Command {},
		CreateMultipartUploadCommand: class CreateMultipartUploadCommand extends Command {},
		DeleteObjectCommand: class DeleteObjectCommand extends Command {},
		GetObjectCommand: class GetObjectCommand extends Command {},
		HeadBucketCommand: class HeadBucketCommand extends Command {},
		HeadObjectCommand: class HeadObjectCommand extends Command {},
		ListMultipartUploadsCommand: class ListMultipartUploadsCommand extends Command {},
		PutObjectCommand: class PutObjectCommand extends Command {},
		UploadPartCommand: class UploadPartCommand extends Command {},
		S3Client: class {
			send = transport.send;
		},
	};
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));

import type {
	AccountInputCopyClaim,
	AccountInputCopyDependencies,
} from "../../../jobs/src/contracts";
import {
	cleanupAccountInputCopyOrphan,
	copyAccountInput,
} from "../../../jobs/src/handlers/account-input-copy";
import {
	abortMultipartUpload,
	deleteObject,
	listMultipartUploads,
	promoteStagedObject,
} from "./index";

const original = Buffer.from("89504e470d0a1a0a0000000d494844520000000000000000", "hex");
const hash = createHash("sha256").update(original).digest("hex");
const claim: AccountInputCopyClaim = {
	promotionId: "promotion",
	leaseToken: "lease",
	source: {
		assetId: "guest",
		objectKey: "users/guest/assets/guest/versions/source/original.png",
		checksum: hash,
		bytes: original.length,
		mimeType: "image/png",
	},
	target: {
		assetId: "target",
		ownerId: "account",
		objectKey: "users/account/assets/target/versions/copy/original.png",
	},
};

function storageFixture() {
	const objects = new Map<string, Buffer>([[claim.source.objectKey, original]]);
	const multipart = new Map<string, { key: string; parts: Buffer[] }>();
	const calls: Array<{ name: string; key: string }> = [];
	let nextUpload = 0;
	let beforeComplete: (() => Promise<void>) | undefined;
	transport.send.mockImplementation(
		async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
			const name = command.constructor.name,
				key = typeof command.input.Key === "string" ? command.input.Key : "";
			calls.push({ name, key });
			switch (name) {
				case "GetObjectCommand": {
					const bytes = objects.get(key);
					if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
					return {
						Body: Readable.from([bytes]),
						ContentLength: bytes.length,
						ContentType: "image/png",
						ETag: hash,
						VersionId: "version",
					};
				}
				case "CreateMultipartUploadCommand": {
					const uploadId = `upload-${++nextUpload}`;
					multipart.set(uploadId, { key, parts: [] });
					return { UploadId: uploadId };
				}
				case "UploadPartCommand": {
					const upload = multipart.get(String(command.input.UploadId));
					if (!upload) throw Object.assign(new Error("missing upload"), { name: "NoSuchUpload" });
					upload.parts[Number(command.input.PartNumber) - 1] = Buffer.from(
						command.input.Body as Uint8Array,
					);
					return { ETag: "part" };
				}
				case "CompleteMultipartUploadCommand": {
					expect(command.input.IfNoneMatch).toBe("*");
					const upload = multipart.get(String(command.input.UploadId));
					if (!upload) throw Object.assign(new Error("missing upload"), { name: "NoSuchUpload" });
					// Capture an already accepted operation: its completion may remain uncertain
					// even if a later abort/delete returns before the final write is observed.
					const bytes = Buffer.concat(upload.parts);
					await beforeComplete?.();
					if (objects.has(key))
						throw Object.assign(new Error("winner exists"), { name: "PreconditionFailed" });
					objects.set(key, bytes);
					multipart.delete(String(command.input.UploadId));
					return {};
				}
				case "AbortMultipartUploadCommand":
					multipart.delete(String(command.input.UploadId));
					return {};
				case "ListMultipartUploadsCommand":
					return {
						Uploads: [...multipart].map(([UploadId, value]) => ({ UploadId, Key: value.key })),
					};
				case "DeleteObjectCommand":
					objects.delete(key);
					return {};
				default:
					throw new Error(`UNEXPECTED_STORAGE_COMMAND:${name}`);
			}
		},
	);
	return {
		objects,
		calls,
		setBeforeComplete(value: () => Promise<void>) {
			beforeComplete = value;
		},
	};
}

function databaseFixture(): {
	dependencies: AccountInputCopyDependencies;
	failures: boolean[];
	terminal(): void;
	readonly committed: boolean;
} {
	let terminal = false,
		committed = false;
	const failures: boolean[] = [];
	return {
		dependencies: {
			claim: async () => (terminal ? null : structuredClone(claim)),
			registerMultipart: async () => undefined,
			clearMultipart: async () => undefined,
			copy: promoteStagedObject,
			commit: async () => {
				if (terminal) throw new Error("COPY_TERMINAL");
				committed = true;
			},
			fail: async (input) => {
				failures.push(input.definitive);
				if (input.definitive) terminal = true;
			},
		},
		failures,
		terminal() {
			terminal = true;
		},
		get committed() {
			return committed;
		},
	};
}

beforeEach(() => {
	transport.send.mockReset();
});

describe("account copy through real immutable S3 command paths with a simulated store", () => {
	it("survives an old source deletion and recovers storage success before DB commit on the same target", async () => {
		const storage = storageFixture(),
			database = databaseFixture();
		const commit = database.dependencies.commit;
		let loseResponse = true;
		database.dependencies.commit = async (input) => {
			if (loseResponse) {
				loseResponse = false;
				throw new Error("DB_RESPONSE_LOST");
			}
			await commit(input);
		};
		await expect(
			copyAccountInput({ promotionId: "promotion" }, database.dependencies),
		).rejects.toThrow("DB_RESPONSE_LOST");
		await deleteObject({ bucket: "media", key: claim.source.objectKey });
		const sourceReads = storage.calls.filter(
			(call) => call.name === "GetObjectCommand" && call.key === claim.source.objectKey,
		).length;
		await copyAccountInput({ promotionId: "promotion" }, database.dependencies);
		expect(
			storage.calls.filter(
				(call) => call.name === "GetObjectCommand" && call.key === claim.source.objectKey,
			),
		).toHaveLength(sourceReads);
		expect(storage.objects.get(claim.target.objectKey)).toEqual(original);
		expect(database.committed).toBe(true);
		expect(
			storage.calls.filter(
				(call) => call.name === "GetObjectCommand" && call.key === claim.target.objectKey,
			).length,
		).toBeGreaterThanOrEqual(3);
		expect(
			storage.calls.filter((call) => call.name === "DeleteObjectCommand").map((call) => call.key),
		).toEqual([claim.source.objectKey]);
	});

	it("rejects an existing destination with equal size and MIME but different bytes without overwriting it", async () => {
		const storage = storageFixture(),
			database = databaseFixture();
		const wrong = Buffer.from(original);
		wrong[wrong.length - 1] = 1;
		storage.objects.set(claim.target.objectKey, wrong);
		expect(await copyAccountInput({ promotionId: "promotion" }, database.dependencies)).toEqual({
			outcome: "FAILED",
		});
		expect(storage.objects.get(claim.target.objectKey)).toEqual(wrong);
		expect(database.failures).toEqual([true]);
		expect(database.committed).toBe(false);
		expect(storage.calls.map((call) => call.name)).toEqual(["GetObjectCommand"]);
	});

	it("aborts only its newly created MPU when durable registration fails and keeps the source intact", async () => {
		const storage = storageFixture(),
			database = databaseFixture();
		database.dependencies.registerMultipart = async () => {
			throw new Error("REGISTRATION_UNCERTAIN");
		};
		await expect(
			copyAccountInput({ promotionId: "promotion" }, database.dependencies),
		).rejects.toThrow("REGISTRATION_UNCERTAIN");
		expect(storage.objects.get(claim.source.objectKey)).toEqual(original);
		expect(storage.objects.has(claim.target.objectKey)).toBe(false);
		expect(database.failures).toEqual([false]);
		expect(storage.calls.some((call) => call.name === "AbortMultipartUploadCommand")).toBe(true);
		expect(
			storage.calls.some((call) =>
				["DeleteObjectCommand", "UploadPartCommand"].includes(call.name),
			),
		).toBe(false);
	});

	it("never resurrects a terminal target after a late Complete, and a later orphan pass removes it again", async () => {
		const storage = storageFixture(),
			database = databaseFixture();
		let reached!: () => void, release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		storage.setBeforeComplete(async () => {
			reached();
			await gate;
		});
		const copying = copyAccountInput({ promotionId: "promotion" }, database.dependencies);
		const rejected = expect(copying).rejects.toThrow("COPY_TERMINAL");
		await waiting;
		database.terminal();
		let passes = 0;
		const orphanDependencies = {
			claim: async () => ({
				promotionId: "promotion",
				assetId: claim.target.assetId,
				objectKey: claim.target.objectKey,
			}),
			listMultipartUploads,
			abortMultipartUpload,
			deleteObject,
			recordPass: async () => {
				passes++;
			},
		};
		await cleanupAccountInputCopyOrphan({ promotionId: "promotion" }, orphanDependencies);
		expect(storage.objects.has(claim.target.objectKey)).toBe(false);
		release();
		await rejected;
		expect(storage.objects.get(claim.target.objectKey)).toEqual(original);
		expect(database.committed).toBe(false);
		await cleanupAccountInputCopyOrphan({ promotionId: "promotion" }, orphanDependencies);
		expect(storage.objects.has(claim.target.objectKey)).toBe(false);
		expect(passes).toBe(2);
		expect(storage.objects.get(claim.source.objectKey)).toEqual(original);
	});
});
