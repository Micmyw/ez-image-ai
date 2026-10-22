import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { runWithRemoteMediaTransport } from "../../lib/remote-media-runtime";
import * as storage from "./index";

const endpoint = process.env.S3_ENDPOINT ?? "";
const bucket = process.env.MEDIA_BUCKET_NAME ?? "";
if (
	!endpoint ||
	!["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname) ||
	!bucket.includes("test")
)
	throw new Error("ISOLATED_VIDEO_TEST_STORAGE_REQUIRED");
beforeAll(async () => {
	const s3 = new S3Client({
		endpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials: {
			accessKeyId: process.env.S3_ACCESS_KEY_ID!,
			secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
		},
	});
	try {
		await s3.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (error) {
		if (
			!error ||
			typeof error !== "object" ||
			!("name" in error) ||
			!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(String(error.name))
		)
			throw error;
	}
	s3.destroy();
});
describe("video immutable input and range storage (isolated MinIO)", () => {
	it.each(["jpeg", "png", "webp"] as const)(
		"seals %s before review and cannot overwrite it through the staged PUT",
		async (format) => {
			const id = randomUUID();
			const staging = { bucket: "media" as const, key: `users/video-test/staging/${id}.${format}` };
			const final = { bucket: "media" as const, key: `users/video-test/final/${id}.${format}` };
			const normalized = { bucket: "media" as const, key: `${final.key}.video-input.png` };
			const contentType = `image/${format}` as const;
			const original = await sharp({
				create: { width: 128, height: 96, channels: 3, background: "#224466" },
			})
				.withMetadata({ orientation: 6 })
				.toFormat(format)
				.toBuffer();
			const replacement = Buffer.from(original);
			replacement[replacement.length - 5] ^= 1;
			try {
				const url = await storage.createSignedUpload({
					...staging,
					contentType,
					contentLength: original.length,
				});
				expect(
					(
						await fetch(url, {
							method: "PUT",
							headers: { "content-type": contentType },
							body: Uint8Array.from(original).buffer,
						})
					).ok,
				).toBe(true);
				const sealed = await storage.promoteStagedObject({
					staging,
					final,
					contentType,
					contentLength: original.length,
				});
				expect(
					await storage.inspectPrivateImage({
						...final,
						contentType,
						contentLength: original.length,
						ifMatch: sealed.etag!,
					}),
				).toEqual({ width: 128, height: 96 });
				expect(
					(
						await fetch(url, {
							method: "PUT",
							headers: { "content-type": contentType },
							body: Uint8Array.from(replacement).buffer,
						})
					).ok,
				).toBe(true);
				expect(
					(
						await storage.inspectPrivateMediaObject({
							...final,
							contentType,
							contentLength: original.length,
						})
					).sha256,
				).toBe(sealed.sha256);
				{
					const converted = await storage.normalizeVideoReferenceToPng({
						source: final,
						final: normalized,
						sourceBytes: original.length,
						sourceEtag: sealed.etag!,
						sourceContentType: contentType,
						maximumBytes: 10_000_000,
					});
					expect(converted).toMatchObject({ width: 96, height: 128 });
					expect(
						await storage.inspectPrivateImage({
							...normalized,
							contentType: "image/png",
							contentLength: converted.bytes,
							ifMatch: converted.etag!,
						}),
					).toEqual({ width: 96, height: 128 });
					const canonicalRead = await storage.readPrivateMediaStream({
						...normalized,
						ifMatch: converted.etag!,
					});
					const canonicalBytes = Buffer.from(await new Response(canonicalRead.body).arrayBuffer());
					const canonicalMetadata = await sharp(canonicalBytes).metadata();
					expect(canonicalMetadata.orientation).toBeUndefined();
					expect(canonicalMetadata.exif).toBeUndefined();
					expect(
						await storage.normalizeVideoReferenceToPng({
							source: final,
							final: normalized,
							sourceBytes: original.length,
							sourceEtag: sealed.etag!,
							sourceContentType: contentType,
							maximumBytes: 10_000_000,
						}),
					).toEqual(converted);
				}
				const range = await storage.readPrivateMediaStream({
					...final,
					range: { start: 0, end: 7 },
					ifMatch: sealed.etag!,
				});
				expect(range.contentLength).toBe(8);
				expect(Buffer.from(await new Response(range.body).arrayBuffer())).toEqual(
					original.subarray(0, 8),
				);
				await expect(
					storage.readPrivateMediaStream({ ...final, ifMatch: '"incorrect-etag"' }),
				).rejects.toMatchObject({ name: "PreconditionFailed" });
			} finally {
				await Promise.all(
					[staging, final, normalized].map((location) => storage.deleteObject(location)),
				);
			}
		},
	);
	it("uses the real conditional-write winner and recovers it after source reclamation", async () => {
		const id = randomUUID();
		const source = { bucket: "media" as const, key: `users/video-test/final/${id}.webp` };
		const final = { bucket: "media" as const, key: `${source.key}.template-input.png` };
		const original = await sharp({
			create: { width: 160, height: 90, channels: 3, background: "orange" },
		})
			.webp()
			.toBuffer();
		const winner = await sharp({
			create: { width: 180, height: 320, channels: 3, background: "blue" },
		})
			.png()
			.toBuffer();
		try {
			const sourceEtag = await putFixture(source, original, "image/webp");
			const winnerEtag = await putFixture(final, winner, "image/png");
			const input = {
				source,
				final,
				sourceBytes: original.length,
				sourceEtag,
				maximumBytes: 10_000_000,
			};
			const canonical = await storage.normalizeVideoReferenceToPng(input);
			expect(canonical).toMatchObject({
				bytes: winner.length,
				sha256: createHash("sha256").update(winner).digest("hex"),
				etag: winnerEtag,
				width: 180,
				height: 320,
			});
			await expect(
				storage.normalizeVideoReferenceToPng({ ...input, preserveDimensions: true }),
			).rejects.toThrow("VIDEO_INPUT_DIMENSIONS_CHANGED");
			await storage.deleteObject(source);
			expect(await storage.normalizeVideoReferenceToPng(input)).toEqual(canonical);
		} finally {
			await Promise.all([source, final].map((location) => storage.deleteObject(location)));
		}
	});
	it("rejects an actual stored collision with truncated PNG pixel data", async () => {
		const id = randomUUID();
		const source = { bucket: "media" as const, key: `users/video-test/final/${id}.webp` };
		const final = { bucket: "media" as const, key: `${source.key}.template-input.png` };
		const original = await sharp({
			create: { width: 160, height: 90, channels: 3, background: "orange" },
		})
			.webp()
			.toBuffer();
		const valid = await sharp(original).png().toBuffer();
		const truncated = valid.subarray(0, Math.floor(valid.length / 2));
		expect((await sharp(truncated).metadata()).width).toBe(160);
		try {
			const sourceEtag = await putFixture(source, original, "image/webp");
			await putFixture(final, truncated, "image/png");
			await expect(
				storage.normalizeVideoReferenceToPng({
					source,
					final,
					sourceBytes: original.length,
					sourceEtag,
					maximumBytes: 10_000_000,
				}),
			).rejects.toThrow();
		} finally {
			await Promise.all([source, final].map((location) => storage.deleteObject(location)));
		}
	});
	it("writes a checked template scene once and replays it without the fixture supplier", async () => {
		const location = {
			bucket: "media" as const,
			key: `users/video-test/scene/${randomUUID()}.png`,
		};
		const source = await sharp({
			create: { width: 160, height: 90, channels: 3, background: "orange" },
		})
			.withMetadata({ orientation: 6 })
			.jpeg()
			.toBuffer();
		let requests = 0;
		try {
			await runWithRemoteMediaTransport(
				{
					exactHostsOnly: true,
					resolve: async () => [{ address: "8.8.8.8", family: 4 }],
					async request() {
						requests += 1;
						if (requests !== 1) throw new Error("FIXTURE_SOURCE_EXPIRED");
						return {
							status: 200,
							headers: { "content-type": "image/jpeg" },
							stream: Readable.from([source]),
						};
					},
				},
				async () => {
					const input = {
						...location,
						sourceUrl: "https://scene-fixture.example/scene.jpg",
						allowedHosts: ["scene-fixture.example"],
						maximumBytes: 10_000_000,
					};
					const result = await storage.storeImmutableVideoTemplateScene(input);
					expect(result).toMatchObject({ width: 90, height: 160 });
					const stored = await storage.readPrivateMediaStream({
						...location,
						ifMatch: result.etag!,
					});
					const actual = Buffer.from(await new Response(stored.body).arrayBuffer());
					expect(result.bytes).toBe(actual.length);
					expect(result.sha256).toBe(createHash("sha256").update(actual).digest("hex"));
					expect((await sharp(actual).metadata()).exif).toBeUndefined();
					expect(await storage.storeImmutableVideoTemplateScene(input)).toEqual(result);
					expect(requests).toBe(1);
				},
			);
		} finally {
			await storage.deleteObject(location);
		}
	});
	it("rejects forged MIME and invalid image content", async () => {
		const key = `users/video-test/staging/${randomUUID()}.png`;
		const invalid = Buffer.alloc(128, 0x61);
		const url = await storage.createSignedUpload({
			bucket: "media",
			key,
			contentType: "image/png",
			contentLength: invalid.length,
		});
		try {
			await fetch(url, {
				method: "PUT",
				headers: { "content-type": "image/png" },
				body: Uint8Array.from(invalid).buffer,
			});
			await expect(
				storage.inspectPrivateImage({
					bucket: "media",
					key,
					contentType: "image/png",
					contentLength: invalid.length,
				}),
			).rejects.toThrow();
		} finally {
			await storage.deleteObject({ bucket: "media", key });
		}
	});
	it("rejects a truncated PNG even when its dimensions are readable", async () => {
		const key = `users/video-test/staging/${randomUUID()}.png`;
		const valid = await sharp({
			create: { width: 640, height: 480, channels: 3, background: "#224466" },
		})
			.png()
			.toBuffer();
		const truncated = valid.subarray(0, Math.floor(valid.length / 2));
		expect((await sharp(truncated).metadata()).width).toBe(640);
		const url = await storage.createSignedUpload({
			bucket: "media",
			key,
			contentType: "image/png",
			contentLength: truncated.length,
		});
		try {
			await fetch(url, {
				method: "PUT",
				headers: { "content-type": "image/png" },
				body: Uint8Array.from(truncated).buffer,
			});
			await expect(
				storage.inspectPrivateImage({
					bucket: "media",
					key,
					contentType: "image/png",
					contentLength: truncated.length,
				}),
			).rejects.toThrow();
		} finally {
			await storage.deleteObject({ bucket: "media", key });
		}
	});
});

async function putFixture(
	location: { bucket: "media"; key: string },
	body: Buffer,
	contentType: "image/png" | "image/webp",
) {
	const uploadUrl = await storage.createSignedUpload({
		...location,
		contentType,
		contentLength: body.length,
	});
	const response = await fetch(uploadUrl, {
		method: "PUT",
		headers: { "content-type": contentType },
		body: Uint8Array.from(body).buffer,
	});
	expect(response.ok).toBe(true);
	const etag = response.headers.get("etag");
	expect(etag).toBeTruthy();
	return etag!;
}
