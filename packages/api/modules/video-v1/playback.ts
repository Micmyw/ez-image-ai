import { auth } from "@repo/auth";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { authorizeVideoPlayback } from "@repo/database/video-v1-fulfillment";
import { headObject, readPrivateMediaStream } from "@repo/storage";

import { parseVideoRange, signPlaybackGrant, verifyPlaybackGrant } from "./playback-policy";

export async function createVideoPlayback(userId: string, jobId: string, download = false) {
	const asset = await authorizeVideoPlayback(userId, jobId);
	if (!asset?.checksum) throw new Error("NOT_FOUND");
	const expires = Math.min(
		Date.now() + 300_000,
		asset.verificationValidUntil?.getTime() ?? 0,
		asset.deleteAfter?.getTime() ?? Infinity,
	);
	if (expires <= Date.now()) throw new Error("VIDEO_ACCESS_EXPIRED");
	const signature = signPlaybackGrant(
		{ userId, jobId, assetId: asset.id, checksum: asset.checksum, expires, download },
		process.env.BETTER_AUTH_SECRET ?? "",
	);
	const params = new URLSearchParams({
		expires: String(expires),
		signature,
		download: download ? "1" : "0",
	});
	return {
		url: `/api/video-v1/jobs/${encodeURIComponent(jobId)}/content?${params}`,
		expiresAt: new Date(expires).toISOString(),
	};
}

/** Cookie and current DB authorization are rechecked on every GET/HEAD/range request. */
export async function serveVideoPlayback(request: Request, jobId: string): Promise<Response> {
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Accept-Ranges": "bytes",
	});
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user || isAnonymousUser(session.user))
		return new Response(null, { status: 401, headers });
	const asset = await authorizeVideoPlayback(session.user.id, jobId);
	if (!asset?.checksum || !asset.storageEtag) return new Response(null, { status: 404, headers });
	const params = new URL(request.url).searchParams;
	const download = params.get("download") === "1";
	if (
		!verifyPlaybackGrant(
			{
				userId: session.user.id,
				jobId,
				assetId: asset.id,
				checksum: asset.checksum,
				expires: Number(params.get("expires")),
				download,
			},
			params.get("signature") ?? "",
			process.env.BETTER_AUTH_SECRET ?? "",
		)
	)
		return new Response(null, { status: 403, headers });
	const bytes = Number(asset.byteSize);
	const location = { bucket: "media" as const, key: asset.objectKey };
	const actual = await headObject(location);
	if (
		actual.contentLength !== bytes ||
		actual.contentType !== "video/mp4" ||
		actual.etag !== asset.storageEtag
	)
		return new Response(null, { status: 409, headers });
	headers.set("Content-Type", "video/mp4");
	headers.set(
		"Content-Disposition",
		download ? `attachment; filename="${asset.id}.mp4"` : "inline",
	);
	headers.set("ETag", asset.storageEtag);
	// RFC 9110 defines Range for GET; HEAD reports the complete representation.
	const range =
		request.method === "HEAD" ? null : parseVideoRange(request.headers.get("range"), bytes);
	if (range === "invalid") {
		headers.set("Content-Range", `bytes */${bytes}`);
		return new Response(null, { status: 416, headers });
	}
	const contentLength = range ? range.end - range.start + 1 : bytes;
	headers.set("Content-Length", String(contentLength));
	if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${bytes}`);
	if (request.method === "HEAD") return new Response(null, { status: 200, headers });
	const object = await readPrivateMediaStream({
		...location,
		ifMatch: asset.storageEtag,
		...(range ? { range } : {}),
	});
	if (
		object.contentLength !== contentLength ||
		object.contentType !== "video/mp4" ||
		object.etag !== asset.storageEtag
	) {
		await object.body.cancel();
		headers.delete("Content-Length");
		headers.delete("Content-Range");
		return new Response(null, { status: 409, headers });
	}
	return new Response(object.body, { status: range ? 206 : 200, headers });
}
