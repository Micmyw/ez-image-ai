import { maximumMediaStorageBytes } from "@repo/config/server";
import {
	claimProviderOriginalArchive,
	reserveProviderOriginalArchive,
	completeProviderOriginalArchive,
	retryProviderOriginalArchive,
} from "@repo/database";
import type { PrismaClient } from "@repo/database/generated-client";
import {
	tryWriteImmutableGenerationImage,
	streamRemoteObjectToStorage,
	putPrivateMediaObject,
	promoteStagedObject,
	deleteObject,
	createStagingObjectKey,
	openInspectedRemoteMedia,
	canStreamImmutableGenerationImage,
	config as storageConfig,
	type MediaContentType,
} from "@repo/storage";
import { readProviderCandidateBytes } from "@repo/storage/lib/provider-original-bytes";

import { GenerationTransferRequiresHeavyError } from "../contracts";
import { providerCdnAllowlist } from "../provider-output-policy";

export async function archiveProviderOriginal(
	assetId: string,
	database: PrismaClient,
	environment = process.env,
	streamingTransfersOnly = false,
) {
	let openedSource: Awaited<ReturnType<typeof openInspectedRemoteMedia>> | undefined;
	if (streamingTransfersOnly) {
		const origin = await database.mediaOutputOrigin.findUnique({
			where: { assetId },
			select: { url: true, attempts: true, archiveState: true },
		});
		if (!origin || origin.archiveState !== "PENDING")
			return { continuation: { eventIds: [] as string[] } };
		const asset = await database.mediaAsset.findUnique({
			where: { id: assetId },
			select: { mimeType: true, verificationEngine: true, deletedAt: true, retentionClass: true },
		});
		if (!asset || asset.deletedAt || asset.verificationEngine !== "legacy")
			return { continuation: { eventIds: [] as string[] } };
		if (
			origin.attempts ||
			asset.retentionClass === "GUEST_TRIAL" ||
			!["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType)
		)
			throw new GenerationTransferRequiresHeavyError();
		openedSource = await openInspectedRemoteMedia(origin.url, {
			allowedHosts: providerCdnAllowlist(environment),
			expectedKind: "image",
			maxRedirects: storageConfig.media.remoteMaxRedirects,
			connectTimeoutMs: storageConfig.media.remoteConnectTimeoutMs,
			firstByteTimeoutMs: storageConfig.media.remoteFirstByteTimeoutMs,
			totalTimeoutMs: storageConfig.media.remoteTotalTimeoutMs,
		});
		if (
			openedSource.contentType !== asset.mimeType ||
			!canStreamImmutableGenerationImage({
				contentType: openedSource.contentType,
				contentLength: openedSource.headers["content-length"],
			})
		) {
			openedSource.stream.destroy();
			throw new GenerationTransferRequiresHeavyError();
		}
	}
	try {
		const claim = await claimProviderOriginalArchive(assetId, database);
		if (!claim) return { continuation: { eventIds: [] as string[] } };
		const { asset, origin, token } = claim;
		try {
			const reserve = (bytes: number) =>
				reserveProviderOriginalArchive(
					{
						assetId,
						ownerId: asset.ownerId,
						token,
						bytes,
						maximumStorageBytes: maximumMediaStorageBytes(environment),
					},
					database,
				).then(() => undefined);
			const location = { bucket: "media" as const, key: asset.objectKey };
			const guestBody =
				asset.retentionClass === "GUEST_TRIAL"
					? Buffer.from(
							await readProviderCandidateBytes({
								url: origin.url,
								mimeType: asset.mimeType,
								allowedHosts: providerCdnAllowlist(environment),
								watermark: true,
							}),
						)
					: undefined;
			const written =
				(await tryWriteImmutableGenerationImage({
					...location,
					contentType: asset.mimeType as MediaContentType,
					...(guestBody
						? { body: guestBody }
						: { sourceUrl: origin.url, allowedHosts: providerCdnAllowlist(environment) }),
					...(openedSource ? { openedSource } : {}),
					streamingOnly: !guestBody,
					reserve,
				})) ??
				(await (async () => {
					if (streamingTransfersOnly) throw new Error("ORIGINAL_STREAMING_ARCHIVE_UNAVAILABLE");
					await reserve(25 * 1024 * 1024);
					const staging = {
						bucket: "media" as const,
						key: createStagingObjectKey(
							asset.ownerId,
							asset.id,
							token,
							asset.mimeType as MediaContentType,
						),
					};
					try {
						const staged = guestBody
							? await putPrivateMediaObject({
									...staging,
									body: guestBody,
									contentType: asset.mimeType as MediaContentType,
								})
							: await streamRemoteObjectToStorage({
									...staging,
									sourceUrl: origin.url,
									allowedHosts: providerCdnAllowlist(environment),
									expectedContentType: asset.mimeType as MediaContentType,
									expectedMediaKind: "image",
								});
						const result = await promoteStagedObject({
							staging,
							final: location,
							contentType: asset.mimeType as MediaContentType,
							contentLength: staged.bytes,
							acceptExistingFinalIdentity: true,
							preferSinglePut: true,
						});
						return result;
					} finally {
						// A failed promotion must not leave the known staging object behind.
						// Unknown late writes also remain covered by the independent staging lifecycle.
						await deleteObject(staging).catch(() => undefined);
					}
				})());
			await completeProviderOriginalArchive(
				{
					assetId,
					ownerId: asset.ownerId,
					token,
					bytes: written.bytes,
					checksum: written.sha256,
					etag: written.etag,
					versionId: written.versionId,
				},
				database,
			);
			return { continuation: { eventIds: [] as string[] } };
		} catch {
			const retry = await retryProviderOriginalArchive(assetId, token, database);
			return {
				continuation: {
					eventIds: retry ? [retry.id] : [],
					...(retry ? { notBefore: retry.availableAt.getTime() } : {}),
				},
			};
		}
	} finally {
		openedSource?.stream.destroy();
	}
}
