import type { Sharp } from "sharp";
import sharp from "sharp";

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
		createTransform(): Sharp;
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
			createTransform: () =>
				createGuestWatermarkTransform({
					...dimensions,
					contentType: input.contentType,
				}),
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

export function createGuestWatermarkTransform(input: {
	width: number;
	height: number;
	contentType: GuestWatermarkInput["contentType"];
}): Sharp {
	assertGuestImageDimensions(input.width, input.height);
	const shortest = Math.min(input.width, input.height);
	const padding = Math.max(4, Math.round(shortest * 0.025));
	const maximumPlateWidth = Math.max(1, input.width - padding * 2);
	const plateWidth = Math.min(maximumPlateWidth, Math.max(72, Math.round(input.width * 0.24)));
	const plateHeight = Math.min(
		Math.max(1, input.height - padding * 2),
		Math.max(26, Math.round(plateWidth * 0.3)),
	);
	const fontSize = Math.max(12, Math.round(plateHeight * 0.48));
	const radius = Math.max(4, Math.round(plateHeight * 0.18));
	const left = input.width - padding - plateWidth;
	const top = input.height - padding - plateHeight;
	const svg = Buffer.from(
		`<svg width="${plateWidth}" height="${plateHeight}" xmlns="http://www.w3.org/2000/svg">
			<rect width="${plateWidth}" height="${plateHeight}" rx="${radius}" fill="#111827" fill-opacity="0.72"/>
			<text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="0.5">EzPic</text>
		</svg>`,
	);
	const pipeline = sharp({ sequentialRead: true, failOn: "error" }).composite([
		{ input: svg, left, top, blend: "over" },
	]);
	switch (input.contentType) {
		case "image/jpeg":
			return pipeline.jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: false });
		case "image/png":
			return pipeline.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false });
		case "image/webp":
			return pipeline.webp({ quality: 90, alphaQuality: 100, smartSubsample: false });
	}
}

function assertGuestImageDimensions(width: number, height: number): void {
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 64 ||
		height < 64 ||
		width > 16_384 ||
		height > 16_384
	) {
		throw new GuestWatermarkError("GUEST_WATERMARK_DIMENSIONS_INVALID");
	}
}
