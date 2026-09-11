import { assertGuestImageDimensions } from "../image-processing/geometry";
import type { MediaContentType, MediaObjectLocation } from "../types";

export const GUEST_WATERMARK_VERSION = "ezpic-guest-v1";

export interface GuestWatermarkInput {
	staging: MediaObjectLocation;
	final: MediaObjectLocation;
	contentType: Extract<MediaContentType, `image/${string}`>;
	deleteAfter: Date;
	now?: () => Date;
}

interface GuestWatermarkStoredIdentity {
	bytes: number;
	sha256: string;
	etag?: string;
	versionId?: string;
}

export interface GuestWatermarkResult extends GuestWatermarkStoredIdentity {
	cleanStagingDeletedAt: Date;
}

export interface GuestWatermarkStorageDependencies {
	inspectImage(
		location: MediaObjectLocation,
		contentType: GuestWatermarkInput["contentType"],
	): Promise<{ width: number; height: number }>;
	transformAndStore(input: {
		staging: MediaObjectLocation;
		final: MediaObjectLocation;
		contentType: GuestWatermarkInput["contentType"];
		deleteAfter: Date;
		width: number;
		height: number;
	}): Promise<GuestWatermarkStoredIdentity>;
	deleteObject(location: MediaObjectLocation): Promise<void>;
}

export class GuestWatermarkError extends Error {
	readonly code: string;
	readonly stage = "TRANSFER" as const;
	readonly retryable = false as const;

	constructor(code: string) {
		super(code);
		this.name = "GuestWatermarkError";
		this.code = code;
	}
}

export function createWatermarkStagedGuestImage(
	dependencies: GuestWatermarkStorageDependencies,
): (input: GuestWatermarkInput) => Promise<GuestWatermarkResult> {
	return async (input) => {
		const now = input.now?.() ?? new Date();
		if (input.staging.key === input.final.key) {
			throw new GuestWatermarkError("GUEST_WATERMARK_LOCATION_INVALID");
		}
		if (Number.isNaN(input.deleteAfter.getTime()) || input.deleteAfter <= now) {
			throw new GuestWatermarkError("GUEST_RETENTION_EXPIRED");
		}
		const dimensions = await dependencies.inspectImage(input.staging, input.contentType);
		assertGuestImageDimensions(dimensions.width, dimensions.height);
		const stored = await dependencies.transformAndStore({
			staging: input.staging,
			final: input.final,
			contentType: input.contentType,
			deleteAfter: input.deleteAfter,
			...dimensions,
		});
		if (
			!Number.isSafeInteger(stored.bytes) ||
			stored.bytes <= 0 ||
			!/^[a-f0-9]{64}$/.test(stored.sha256)
		) {
			throw new GuestWatermarkError("GUEST_WATERMARK_IDENTITY_INVALID");
		}
		try {
			await dependencies.deleteObject(input.staging);
		} catch {
			throw new GuestWatermarkError("GUEST_CLEAN_STAGE_DELETE_REQUIRED");
		}
		return { ...stored, cleanStagingDeletedAt: input.now?.() ?? new Date() };
	};
}
