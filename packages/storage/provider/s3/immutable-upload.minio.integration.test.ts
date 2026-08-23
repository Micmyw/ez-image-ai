import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createFinalAssetObjectKey, createStagingObjectKey } from "../../lib/object-key";
import { createSignedReadUrl, createSignedUpload, promoteStagedObject } from "./index";

const endpoint = "http://127.0.0.1:59000";
const bucket = "media-storage-test";

describe("immutable staging upload promotion (MinIO)", () => {
	it("keeps final bytes unchanged when an unexpired staging PUT URL is replayed", async () => {
		process.env.S3_ENDPOINT = endpoint;
		process.env.S3_REGION = "us-east-1";
		process.env.S3_ACCESS_KEY_ID = "minioadmin";
		process.env.S3_SECRET_ACCESS_KEY = "minioadmin";
		process.env.MEDIA_BUCKET_NAME = bucket;
		const id = randomUUID();
		const staging = {
			bucket: "media" as const,
			key: createStagingObjectKey(
				`user_${id.replaceAll("-", "")}`,
				`session_${id.replaceAll("-", "")}`,
				"nonce",
				"image/png",
			),
		};
		const final = {
			bucket: "media" as const,
			key: createFinalAssetObjectKey(
				`user_${id.replaceAll("-", "")}`,
				`asset_${id.replaceAll("-", "")}`,
				"version",
				"image/png",
			),
		};
		const approved = Buffer.from("89504e470d0a1a0a0000000d494844520000000000000000", "hex");
		const replacement = Buffer.from("89504e470d0a1a0a0000000d49484452ffffffffffffffff", "hex");
		const putUrl = await createSignedUpload({
			...staging,
			contentType: "image/png",
			contentLength: approved.byteLength,
		});
		expect(
			(
				await fetch(putUrl, {
					method: "PUT",
					headers: { "content-type": "image/png" },
					body: approved,
				})
			).ok,
		).toBe(true);
		const promoted = await promoteStagedObject({
			...{ staging, final },
			contentType: "image/png",
			contentLength: approved.byteLength,
		});
		expect(promoted.sha256).toBe(createHash("sha256").update(approved).digest("hex"));
		expect(
			(
				await fetch(putUrl, {
					method: "PUT",
					headers: { "content-type": "image/png" },
					body: replacement,
				})
			).ok,
		).toBe(true);
		const finalUrl = await createSignedReadUrl(final);
		const finalBody = Buffer.from(await (await fetch(finalUrl)).arrayBuffer());
		expect(finalBody).toEqual(approved);
		expect(createHash("sha256").update(finalBody).digest("hex")).toBe(promoted.sha256);
	});
});
