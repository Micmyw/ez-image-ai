import type { StorageConfig } from "./types";

export const config = {
	bucketNames: {
		avatars: process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME ?? "avatars",
		media: process.env.MEDIA_BUCKET_NAME ?? "media-private",
	},
	media: {
		signedUploadExpiresSeconds: 10 * 60,
		signedReadExpiresSeconds: 5 * 60,
		multipartPartSize: 8 * 1024 * 1024,
		remoteConnectTimeoutMs: 5_000,
		remoteFirstByteTimeoutMs: 10_000,
		remoteTotalTimeoutMs: 10 * 60 * 1_000,
		remoteMaxRedirects: 3,
	},
} as const satisfies StorageConfig;
