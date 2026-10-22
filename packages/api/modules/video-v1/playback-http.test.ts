import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/auth/lib/anonymous-boundary", () => ({
	isAnonymousUser: (user: { isAnonymous?: boolean }) => user.isAnonymous === true,
}));
vi.mock("@repo/database/video-v1-fulfillment", () => ({ authorizeVideoPlayback: vi.fn() }));
vi.mock("@repo/storage", () => ({ headObject: vi.fn(), readPrivateMediaStream: vi.fn() }));
import { auth } from "@repo/auth";
import { authorizeVideoPlayback } from "@repo/database/video-v1-fulfillment";
import { headObject, readPrivateMediaStream } from "@repo/storage";

import { redactVideoAccessLog } from "./log-redaction";
import {
	createVideoPlayback,
	createVideoPlaybackFromAuthorizedAsset,
	serveVideoPlayback,
} from "./playback";
const asset = {
	id: "asset",
	checksum: "a".repeat(64),
	objectKey: "users/owner/private.mp4",
	storageEtag: '"etag"',
	byteSize: 10n,
	verificationValidUntil: new Date(Date.now() + 3600_000),
	deleteAfter: new Date(Date.now() + 86_400_000),
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BETTER_AUTH_SECRET", "video-local-test-secret-".repeat(3));
	vi.mocked(auth.api.getSession).mockResolvedValue({ user: { id: "owner" } } as never);
	vi.mocked(authorizeVideoPlayback).mockResolvedValue(asset as never);
	vi.mocked(headObject).mockResolvedValue({
		contentLength: 10,
		contentType: "video/mp4",
		etag: asset.storageEtag,
		metadata: {},
	});
	vi.mocked(readPrivateMediaStream).mockImplementation(async (input) => {
		const size = input.range ? input.range.end - input.range.start + 1 : 10;
		return {
			body: new Blob([new Uint8Array(size)]).stream(),
			contentLength: size,
			contentType: "video/mp4",
			etag: asset.storageEtag,
		};
	});
});
afterEach(() => vi.useRealTimers());
async function request(method = "GET", range?: string) {
	const access = await createVideoPlayback("owner", "job");
	return new Request(new URL(access.url, "http://localhost"), {
		method,
		...(range ? { headers: { Range: range } } : {}),
	});
}
describe("private MP4 HTTP semantics", () => {
	it("serves real 206 metadata and streamed range bytes", async () => {
		const response = await serveVideoPlayback(await request("GET", "bytes=2-5"), "job");
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(response.headers.get("content-length")).toBe("4");
		expect((await response.arrayBuffer()).byteLength).toBe(4);
		expect(headObject).not.toHaveBeenCalled();
		expect(readPrivateMediaStream).toHaveBeenCalledExactlyOnceWith({
			bucket: "media",
			key: asset.objectKey,
			ifMatch: asset.storageEtag,
			range: { start: 2, end: 5 },
		});
	});
	it("HEAD has complete length and opens no body", async () => {
		const response = await serveVideoPlayback(await request("HEAD", "bytes=2-5"), "job");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-length")).toBe("10");
		expect(await response.text()).toBe("");
		expect(readPrivateMediaStream).not.toHaveBeenCalled();
		expect(headObject).toHaveBeenCalledTimes(1);
	});
	it("returns 416 for unsatisfiable ranges and full200 for unsupported multi-range", async () => {
		const invalid = await serveVideoPlayback(await request("GET", "bytes=20-"), "job");
		expect(invalid.status).toBe(416);
		expect(invalid.headers.get("content-range")).toBe("bytes */10");
		expect((await serveVideoPlayback(await request("GET", "bytes=0-1,4-5"), "job")).status).toBe(
			200,
		);
	});
	it("revokes existing grants after DB denial and rejects changed object identity", async () => {
		const granted = await request();
		vi.mocked(authorizeVideoPlayback).mockResolvedValueOnce(null);
		expect((await serveVideoPlayback(granted, "job")).status).toBe(404);
		vi.mocked(readPrivateMediaStream).mockResolvedValueOnce({
			contentLength: 10,
			contentType: "video/mp4",
			etag: '"replaced"',
			body: new ReadableStream(),
		});
		expect((await serveVideoPlayback(granted, "job")).status).toBe(409);
	});
	it.each([undefined, "bytes=2-5"])(
		"opens GET %s in one 100ms storage operation instead of HEAD plus GET",
		async (range) => {
			vi.useFakeTimers();
			const granted = await request("GET", range);
			vi.mocked(headObject).mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				return {
					contentLength: 10,
					contentType: "video/mp4",
					etag: asset.storageEtag,
					metadata: {},
				};
			});
			vi.mocked(readPrivateMediaStream).mockImplementation(async (input) => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				const size = input.range ? input.range.end - input.range.start + 1 : 10;
				return {
					contentLength: size,
					contentType: "video/mp4",
					etag: asset.storageEtag,
					body: new Blob([new Uint8Array(size)]).stream(),
				};
			});
			const startedAt = Date.now();
			const pending = serveVideoPlayback(granted, "job");
			await vi.runAllTimersAsync();
			expect((await pending).status).toBe(range ? 206 : 200);
			expect(Date.now() - startedAt).toBe(100);
			expect(headObject).not.toHaveBeenCalled();
			expect(readPrivateMediaStream).toHaveBeenCalledTimes(1);
		},
	);
	it.each([{ name: "PreconditionFailed" }, { $metadata: { httpStatusCode: 412 } }])(
		"returns 409 for an If-Match rejection without exposing a body",
		async (details) => {
			const granted = await request("GET", "bytes=2-5");
			vi.mocked(readPrivateMediaStream).mockRejectedValueOnce(
				Object.assign(new Error("changed"), details),
			);
			const response = await serveVideoPlayback(granted, "job");
			expect(response.status).toBe(409);
			expect(response.headers.has("content-length")).toBe(false);
			expect(response.headers.has("content-range")).toBe(false);
			expect(await response.text()).toBe("");
		},
	);
	it.each([{ contentLength: 9 }, { contentType: "text/html" }, { etag: "other" }])(
		"cancels a GET body with changed identity metadata %j",
		async (changed) => {
			const cancel = vi.fn();
			vi.mocked(readPrivateMediaStream).mockResolvedValueOnce({
				contentLength: 10,
				contentType: "video/mp4",
				etag: asset.storageEtag,
				...changed,
				body: new ReadableStream({ cancel }),
			});
			expect((await serveVideoPlayback(await request(), "job")).status).toBe(409);
			expect(cancel).toHaveBeenCalledTimes(1);
		},
	);
	it("retains HEAD object identity validation", async () => {
		vi.mocked(headObject).mockResolvedValueOnce({
			contentLength: 11,
			contentType: "video/mp4",
			etag: asset.storageEtag,
			metadata: {},
		});
		expect((await serveVideoPlayback(await request("HEAD"), "job")).status).toBe(409);
		expect(readPrivateMediaStream).not.toHaveBeenCalled();
	});
	it("signs already-authorized assets without another database read and still checks expiry", async () => {
		vi.useFakeTimers();
		expect(createVideoPlaybackFromAuthorizedAsset("owner", "job", asset)).toEqual(
			await createVideoPlayback("owner", "job"),
		);
		expect(authorizeVideoPlayback).toHaveBeenCalledTimes(1);
		expect(() => createVideoPlaybackFromAuthorizedAsset("owner", "job", null)).toThrow("NOT_FOUND");
		expect(() =>
			createVideoPlaybackFromAuthorizedAsset("owner", "job", {
				...asset,
				verificationValidUntil: new Date(0),
			}),
		).toThrow("VIDEO_ACCESS_EXPIRED");
	});
	it("rejects expired grants and unsigned anonymous playback", async () => {
		const granted = await request();
		const url = new URL(granted.url);
		url.searchParams.set("expires", "1");
		expect((await serveVideoPlayback(new Request(url), "job")).status).toBe(403);
		vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);
		expect((await serveVideoPlayback(granted, "job")).status).toBe(401);
	});
	it("removes provider correlation tokens and playback signatures from access logs", () => {
		expect(redactVideoAccessLog("POST /api/webhooks/video/kie/privateToken 200")).not.toContain(
			"privateToken",
		);
		expect(
			redactVideoAccessLog("GET /api/video-v1/jobs/job/content?signature=privateGrant 206"),
		).not.toContain("privateGrant");
	});
});
