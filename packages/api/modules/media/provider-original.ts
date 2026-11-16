import { Readable } from "node:stream";

import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { imageModerationProviderForEnvironment } from "@repo/config";
import { isApprovedImageResult } from "@repo/config/image-result";
import { db } from "@repo/database/client";
import { hasCurrentApprovedMediaAssetEvidence } from "@repo/database/media-assets";
import { providerCdnAllowlist } from "@repo/jobs/provider-output-policy";
import { readImageResult } from "@repo/jobs/realtime/image-result";
import { verifyProviderOriginalReadUrl, readArchivedMediaStream } from "@repo/storage";
import { openInspectedRemoteMedia, config as storageConfig } from "@repo/storage";
import {
	readProviderOriginalBytes,
	readProviderCandidateBytes,
} from "@repo/storage/lib/provider-original-bytes";

import { authorizeImageResult, verifyImageResultReadUrl } from "./lib/image-result";

const evidence = {
	moderationResults: {
		orderBy: [
			{ verificationGeneration: "desc" as const },
			{ attemptNumber: "desc" as const },
			{ createdAt: "desc" as const },
			{ id: "desc" as const },
		],
		take: 1,
	},
};

export async function serveProviderOriginal(request: Request): Promise<Response> {
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	});
	if (new URL(request.url).searchParams.has("result")) {
		const grant = verifyImageResultReadUrl(new URL(request.url));
		if (!grant) return new Response(null, { status: 403, headers });
		const receipt = await readImageResult(grant.jobId).catch(() => null);
		if (!receipt || receipt.assetId !== grant.assetId || !isApprovedImageResult(receipt))
			return new Response(null, { status: 404, headers });
		headers.set(
			"Content-Disposition",
			grant.disposition === "inline"
				? "inline"
				: `attachment; filename="${receipt.assetId}.${receipt.mimeType === "image/svg+xml" ? "svg" : receipt.mimeType.slice(6)}"`,
		);
		let pendingSource: Readable | undefined;
		try {
			if (receipt.context.guest) {
				const bytes = await readProviderCandidateBytes({
					url: receipt.completion.outputUrl,
					mimeType: receipt.mimeType,
					allowedHosts: providerCdnAllowlist(process.env),
					watermark: true,
				});
				if (!(await authorizeImageResult(receipt, grant.ownerId)) || grant.expires <= Date.now())
					return new Response(null, { status: 404, headers });
				headers.set("Content-Type", receipt.mimeType);
				headers.set("Content-Length", String(bytes.length));
				return new Response(request.method === "HEAD" ? null : bytes, { headers });
			}
			const opened = await openInspectedRemoteMedia(receipt.completion.outputUrl, {
				allowedHosts: providerCdnAllowlist(process.env),
				expectedKind: "image",
				maxRedirects: storageConfig.media.remoteMaxRedirects,
				connectTimeoutMs: storageConfig.media.remoteConnectTimeoutMs,
				firstByteTimeoutMs: storageConfig.media.remoteFirstByteTimeoutMs,
				totalTimeoutMs: storageConfig.media.remoteTotalTimeoutMs,
			});
			pendingSource = opened.stream;
			// One fresh authorization after source headers are ready covers deletion
			// and policy changes during connection setup, without two DB reads.
			if (!(await authorizeImageResult(receipt, grant.ownerId)) || grant.expires <= Date.now()) {
				opened.stream.destroy();
				return new Response(null, { status: 404, headers });
			}
			headers.set("Content-Type", opened.contentType);
			if (opened.contentType === "image/svg+xml")
				headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
			const length = Number(opened.headers["content-length"]);
			if (Number.isSafeInteger(length) && length > 0) headers.set("Content-Length", String(length));
			if (length > 25 * 1024 * 1024) {
				opened.stream.destroy();
				throw new Error("ORIGINAL_SIZE_EXCEEDED");
			}
			if (request.method === "HEAD") {
				opened.stream.destroy();
				return new Response(null, { headers });
			}
			let size = 0;
			const stream = (Readable.toWeb(opened.stream) as ReadableStream<Uint8Array>).pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						size += chunk.length;
						if (size > 25 * 1024 * 1024) throw new Error("ORIGINAL_SIZE_EXCEEDED");
						controller.enqueue(chunk);
					},
				}),
			);
			// Stream the approved original. No full-body buffering/hash, R2 lookup,
			// settlement check or post-download database read is on this path.
			return new Response(stream, { headers });
		} catch {
			pendingSource?.destroy();
			return new Response(null, { status: 503, headers });
		}
	}
	const grant = verifyProviderOriginalReadUrl(new URL(request.url));
	if (!grant) return new Response(null, { status: 403, headers });
	const asset = await db.mediaAsset.findUnique({
		where: { objectKey: grant.key },
		include: evidence,
	});
	if (
		!asset ||
		asset.kind !== "OUTPUT" ||
		asset.verificationEngine !== "legacy" ||
		asset.deletedAt ||
		asset.status === "DELETED" ||
		(asset.deleteAfter && asset.deleteAfter <= new Date()) ||
		(grant.scope !== "admin" &&
			!hasCurrentApprovedMediaAssetEvidence(asset, {
				provider: imageModerationProviderForEnvironment(process.env),
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				now: new Date(),
			}))
	)
		return new Response(null, { status: 404, headers });
	const origin = await db.mediaOutputOrigin.findUnique({ where: { assetId: asset.id } });
	if (!origin) return new Response(null, { status: 404, headers });
	if (!asset.checksum || asset.byteSize < 1n) return new Response(null, { status: 503, headers });
	const etag = `"${asset.checksum}"`;
	if (request.headers.has("if-match") && request.headers.get("if-match") !== etag)
		return new Response(null, { status: 412, headers });
	headers.set("ETag", etag);
	headers.set("Content-Type", asset.mimeType);
	if (asset.mimeType === "image/svg+xml")
		headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
	headers.set("Content-Disposition", grant.disposition);
	headers.set("Content-Length", String(asset.byteSize));
	if (request.method === "HEAD") return new Response(null, { headers });
	try {
		let body: ReadableStream<Uint8Array> | Uint8Array | undefined;
		if (
			origin.archiveState === "ARCHIVED" &&
			origin.archiveChecksum === asset.checksum &&
			origin.archiveBytes === asset.byteSize
		) {
			try {
				const stored = await readArchivedMediaStream({ bucket: "media", key: asset.objectKey });
				if (
					stored.contentLength !== Number(asset.byteSize) ||
					stored.contentType !== asset.mimeType
				) {
					await stored.body.cancel();
					throw new Error("ORIGINAL_ARCHIVE_IDENTITY_CHANGED");
				}
				body = stored.body;
			} catch {
				/* The still-valid provider original remains usable during an R2 outage. */
			}
		}
		if (!body) {
			body = await readProviderOriginalBytes({
				url: origin.url,
				checksum: asset.checksum!,
				bytes: Number(asset.byteSize),
				mimeType: asset.mimeType,
				allowedHosts: providerCdnAllowlist(process.env),
				...(asset.retentionClass === "GUEST_TRIAL" ? { watermark: true } : {}),
			});
		}
		// Withdrawal/deletion/expiry may race either download. Recheck before releasing bytes.
		const current = await db.mediaAsset.findUnique({ where: { id: asset.id }, include: evidence });
		if (
			!current ||
			current.deletedAt ||
			current.status === "DELETED" ||
			current.checksum !== asset.checksum ||
			current.verificationGeneration !== asset.verificationGeneration ||
			(current.deleteAfter && current.deleteAfter <= new Date()) ||
			(grant.scope !== "admin" &&
				!hasCurrentApprovedMediaAssetEvidence(current, {
					provider: imageModerationProviderForEnvironment(process.env),
					ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					now: new Date(),
				}))
		) {
			if (body instanceof ReadableStream) await body.cancel().catch(() => undefined);
			return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
		}
		return new Response(body as BodyInit, { headers });
	} catch {
		return new Response(null, {
			status: 503,
			headers: { "Cache-Control": "private, no-store", "Retry-After": "2" },
		});
	}
}
