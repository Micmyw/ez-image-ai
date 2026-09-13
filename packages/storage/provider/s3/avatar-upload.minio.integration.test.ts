import { randomUUID } from "node:crypto";

import { CreateBucketCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const endpoint = process.env.S3_ENDPOINT;
if (!endpoint || !["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname))
	throw new Error("A disposable loopback S3_ENDPOINT is required");
const bucket = "avatars-security-test";
process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME = bucket;
const client = new S3Client({
	endpoint,
	region: "us-east-1",
	forcePathStyle: true,
	credentials: {
		accessKeyId: process.env.S3_ACCESS_KEY_ID!,
		secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
	},
});
const objectKeys: string[] = [];
let storage: typeof import("./index");

describe("avatar presigned PUT storage enforcement", () => {
	beforeAll(async () => {
		try {
			await client.send(new CreateBucketCommand({ Bucket: bucket }));
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error.name)
			)
				throw error;
		}
		storage = await import("./index");
	});
	afterAll(async () => {
		for (const Key of objectKeys)
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
		client.destroy();
	});

	it("accepts the exact body while rejecting a different size or MIME type", async () => {
		const key = `${randomUUID()}.png`;
		objectKeys.push(key);
		const body = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
		const url = await storage.getSignedUploadUrl(key, {
			bucket: "avatars",
			contentType: "image/png",
			contentLength: body.byteLength,
		});
		const exact = await fetch(url, {
			method: "PUT",
			headers: { "content-type": "image/png" },
			body,
		});
		expect({ status: exact.status, body: await exact.text() }).toMatchObject({ status: 200 });
		const larger = await fetch(url, {
			method: "PUT",
			headers: { "content-type": "image/png" },
			body: new Uint8Array(body.byteLength + 1),
		});
		expect(larger.status).toBe(403);
		const differentMime = await fetch(url, {
			method: "PUT",
			headers: { "content-type": "image/jpeg" },
			body,
		});
		expect(differentMime.status).toBe(403);
	});
});
