export interface StorageBucketNamesConfig {
	/**
	 * Bucket used for user and organization avatar uploads.
	 */
	avatars: string;
	/** Private media assets. Browser clients never receive this bucket name. */
	media: string;
}

export interface StorageConfig {
	/**
	 * Logical storage bucket names used throughout the application.
	 */
	bucketNames: StorageBucketNamesConfig;
	media: {
		signedUploadExpiresSeconds: number;
		signedReadExpiresSeconds: number;
		multipartPartSize: number;
		remoteConnectTimeoutMs: number;
		remoteFirstByteTimeoutMs: number;
		remoteTotalTimeoutMs: number;
		remoteMaxRedirects: number;
	};
}

export type MediaContentType =
	| "image/jpeg"
	| "image/png"
	| "image/webp"
	| "video/mp4"
	| "video/webm"
	| "video/quicktime";

export type MediaDerivativeKind = "original" | "thumbnail" | "preview";

export interface MediaObjectLocation {
	bucket: "media";
	key: string;
}

export interface SignedUploadInput extends MediaObjectLocation {
	contentType: MediaContentType;
	contentLength: number;
	expiresIn?: number;
}

export interface MultipartUploadInput extends MediaObjectLocation {
	contentType: MediaContentType;
	metadata?: Record<string, string>;
}

export interface MultipartUploadPart {
	partNumber: number;
	etag: string;
}

export interface MediaObjectMetadata {
	contentLength: number;
	contentType: string | null;
	etag: string | null;
	metadata: Record<string, string>;
}

export interface SignedReadInput extends MediaObjectLocation {
	expiresIn?: number;
	responseContentDisposition?: "inline" | `attachment; filename="${string}"`;
}

export interface StorageMultipartAdapter {
	createMultipartUpload(input: MultipartUploadInput): Promise<{ uploadId: string }>;
	signMultipartPart(
		input: MediaObjectLocation & {
			uploadId: string;
			partNumber: number;
			contentLength: number;
			expiresIn?: number;
		},
	): Promise<string>;
	uploadMultipartPart(
		input: MediaObjectLocation & { uploadId: string; partNumber: number; body: Buffer },
	): Promise<string>;
	completeMultipartUpload(
		input: MediaObjectLocation & { uploadId: string; parts: MultipartUploadPart[] },
	): Promise<void>;
	abortMultipartUpload(input: MediaObjectLocation & { uploadId: string }): Promise<void>;
}

export type CreateBucketHandler = (
	name: string,
	options?: {
		public?: boolean;
	},
) => Promise<void>;

export type GetSignedUploadUrlHandler = (
	path: string,
	options: {
		bucket: keyof StorageBucketNamesConfig;
		contentType?: "image/jpeg" | "image/png";
		contentLength?: number;
	},
) => Promise<string>;

export type GetSignedUrlHander = (
	path: string,
	options: {
		bucket: keyof StorageBucketNamesConfig;
		expiresIn?: number;
	},
) => Promise<string>;
