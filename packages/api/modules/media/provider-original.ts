import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { imageModerationProviderForEnvironment } from "@repo/config";
import { db } from "@repo/database/client";
import { hasCurrentApprovedMediaAssetEvidence } from "@repo/database/media-assets";
import { providerCdnAllowlist } from "@repo/jobs/provider-output-policy";
import { verifyProviderOriginalReadUrl, readArchivedMediaStream } from "@repo/storage";
import { readProviderOriginalBytes } from "@repo/storage/lib/provider-original-bytes";

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
