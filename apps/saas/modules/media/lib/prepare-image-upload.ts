import { getPublicConfig } from "@repo/config/client";

import { IMAGE_UPLOAD_ACCEPT } from "./image-upload-formats";
export { IMAGE_UPLOAD_ACCEPT } from "./image-upload-formats";

const preparedFiles = new WeakMap<File, Promise<File>>();
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
// Decode/canvas memory depends on pixels, independently of compressed file size.
export const MAXIMUM_IMAGE_UPLOAD_PIXELS = 24_000_000;
const maximumDimension = 16_384;
function isHeic(file: File): boolean {
	return /^(image\/hei[cf])$/i.test(file.type) || (!file.type && /\.hei[cf]$/i.test(file.name));
}

/** Selection support is conditional: HEIC still has to pass the native decoder. */
export function isSupportedImageUploadSource(file: File): boolean {
	return Object.hasOwn(IMAGE_UPLOAD_ACCEPT, file.type) || isHeic(file);
}

/** Finish preparation before allocating an immutable upload identity or hashing its bytes. */
export async function prepareImageUpload(
	file: File,
	maximumBytes = getPublicConfig().uploadLimits.imageBytes,
): Promise<File> {
	if (!isSupportedImageUploadSource(file)) return file;
	const byteLimit = Math.min(maximumBytes, getPublicConfig().uploadLimits.imageBytes);
	if (file.size > byteLimit) throw new Error("SOURCE_IMAGE_TOO_LARGE");
	let prepared = preparedFiles.get(file);
	if (!prepared) {
		prepared = normalizeImage(file)
			.then((result) => {
				preparedFiles.set(result, Promise.resolve(result));
				return result;
			})
			.catch((error: unknown) => {
				preparedFiles.delete(file);
				throw error;
			});
		preparedFiles.set(file, prepared);
	}
	const result = await prepared;
	if (result.size > byteLimit) throw new Error("SOURCE_IMAGE_TOO_LARGE");
	return result;
}

function assertDimensions(width: number, height: number): void {
	if (
		!width ||
		!height ||
		width > maximumDimension ||
		height > maximumDimension ||
		width * height > MAXIMUM_IMAGE_UPLOAD_PIXELS
	) {
		throw new Error("SOURCE_IMAGE_DIMENSIONS_TOO_LARGE");
	}
}

async function normalizeImage(file: File): Promise<File> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const view = new DataView(bytes.buffer);
	if (isHeic(file)) {
		assertHeicDimensions(view);
		// PNG preserves any alpha channel; byte limits are rechecked after encoding.
		return encodeImage(file, file, "image/png", 1, true);
	}
	if (bytes.length >= 33 && pngSignature.every((value, index) => bytes[index] === value)) {
		if (view.getUint32(12) !== 0x49484452) throw new Error("SOURCE_IMAGE_UNREADABLE");
		assertDimensions(view.getUint32(16), view.getUint32(20));
		let offset = 8;
		while (offset + 12 <= bytes.length) {
			const length = view.getUint32(offset);
			if (offset + length + 12 > bytes.length) break;
			if (view.getUint32(offset + 4) === 0x49454e44 && length === 0) return file;
			offset += length + 12;
		}
		return encodeImage(file, file, "image/png");
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		const jpeg = inspectJpeg(view);
		if (jpeg.width && jpeg.height) assertDimensions(jpeg.width, jpeg.height);
		if (jpeg.orientation > 1 && jpeg.orientationOffset !== null) {
			if (!jpeg.width || !jpeg.height) throw new Error("SOURCE_IMAGE_UNREADABLE");
			// Neutralize EXIF in decoder input, then apply the transform exactly once.
			view.setUint16(jpeg.orientationOffset, 1, jpeg.littleEndian);
			return encodeImage(
				file,
				new Blob([bytes], { type: "image/jpeg" }),
				"image/jpeg",
				jpeg.orientation,
			);
		}
		return file;
	}
	if (bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
		const chunk = view.getUint32(12);
		if (chunk === 0x56503858) {
			assertDimensions(
				1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
				1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16),
			);
		} else if (chunk === 0x5650384c && bytes[20] === 0x2f) {
			const bits = view.getUint32(21, true);
			assertDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
		} else if (
			chunk === 0x56503820 &&
			bytes[23] === 0x9d &&
			bytes[24] === 1 &&
			bytes[25] === 0x2a
		) {
			assertDimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
		}
	}
	// Unmodified JPEG/PNG/WebP retain bytes, alpha, and server format validation.
	return file;
}

function inspectJpeg(view: DataView) {
	let width = 0;
	let height = 0;
	let orientation = 1;
	let orientationOffset: number | null = null;
	let littleEndian = false;
	for (let offset = 2; offset + 4 <= view.byteLength;) {
		if (view.getUint8(offset) !== 0xff) break;
		const marker = view.getUint8(offset + 1);
		if (marker === 0xda || marker === 0xd9) break;
		const length = view.getUint16(offset + 2);
		if (length < 2 || offset + 2 + length > view.byteLength) break;
		if (
			[0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
				marker,
			) &&
			length >= 8
		) {
			height = view.getUint16(offset + 5);
			width = view.getUint16(offset + 7);
		}
		if (
			marker === 0xe1 &&
			length >= 16 &&
			view.getUint32(offset + 4) === 0x45786966 &&
			view.getUint16(offset + 8) === 0
		) {
			const tiff = offset + 10;
			const end = offset + 2 + length;
			const endian = view.getUint16(tiff) === 0x4949;
			if ((endian || view.getUint16(tiff) === 0x4d4d) && view.getUint16(tiff + 2, endian) === 42) {
				const ifd = tiff + view.getUint32(tiff + 4, endian);
				if (ifd >= tiff + 8 && ifd + 2 <= end) {
					const count = Math.min(view.getUint16(ifd, endian), 512);
					for (let index = 0; index < count; index++) {
						const entry = ifd + 2 + index * 12;
						if (entry + 12 > end) break;
						if (
							view.getUint16(entry, endian) === 0x0112 &&
							view.getUint16(entry + 2, endian) === 3 &&
							view.getUint32(entry + 4, endian) === 1
						) {
							const value = view.getUint16(entry + 8, endian);
							if (value >= 1 && value <= 8) {
								orientation = value;
								orientationOffset = entry + 8;
								littleEndian = endian;
							}
						}
					}
				}
			}
		}
		offset += 2 + length;
	}
	return { width, height, orientation, orientationOffset, littleEndian };
}

function assertHeicDimensions(view: DataView): void {
	if (view.byteLength < 20 || view.getUint32(4) !== 0x66747970)
		throw new Error("SOURCE_IMAGE_HEIC_UNSUPPORTED");
	let found = false;
	let count = 0;
	function boxes(start: number, end: number, depth: number): void {
		if (depth > 8) throw new Error("SOURCE_IMAGE_HEIC_UNSUPPORTED");
		for (let offset = start; offset + 8 <= end;) {
			if (++count > 1024) throw new Error("SOURCE_IMAGE_HEIC_UNSUPPORTED");
			let size = view.getUint32(offset);
			const type = view.getUint32(offset + 4);
			let header = 8;
			if (size === 1) {
				if (offset + 16 > end || view.getUint32(offset + 8) !== 0)
					throw new Error("SOURCE_IMAGE_HEIC_UNSUPPORTED");
				size = view.getUint32(offset + 12);
				header = 16;
			} else if (size === 0) size = end - offset;
			if (size < header || offset + size > end) throw new Error("SOURCE_IMAGE_HEIC_UNSUPPORTED");
			if (type === 0x69737065 && size >= header + 12) {
				assertDimensions(view.getUint32(offset + header + 4), view.getUint32(offset + header + 8));
				found = true;
			} else if ([0x6d657461, 0x69707270, 0x6970636f].includes(type)) {
				boxes(offset + header + (type === 0x6d657461 ? 4 : 0), offset + size, depth + 1);
			}
			offset += size;
		}
	}
	boxes(0, view.byteLength, 0);
	if (!found) throw new Error("SOURCE_IMAGE_HEIC_UNSUPPORTED");
}

async function encodeImage(
	original: File,
	input: Blob,
	type: "image/png" | "image/jpeg",
	orientation = 1,
	heic = false,
): Promise<File> {
	const image = new Image();
	const url = URL.createObjectURL(input);
	const canvas = document.createElement("canvas");
	try {
		image.src = url;
		await image.decode();
		const width = image.naturalWidth;
		const height = image.naturalHeight;
		assertDimensions(width, height);
		canvas.width = orientation >= 5 ? height : width;
		canvas.height = orientation >= 5 ? width : height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("SOURCE_IMAGE_UNREADABLE");
		const transforms: Record<number, [number, number, number, number, number, number]> = {
			2: [-1, 0, 0, 1, width, 0],
			3: [-1, 0, 0, -1, width, height],
			4: [1, 0, 0, -1, 0, height],
			5: [0, 1, 1, 0, 0, 0],
			6: [0, 1, -1, 0, height, 0],
			7: [0, -1, -1, 0, height, width],
			8: [0, -1, 1, 0, 0, width],
		};
		if (transforms[orientation]) context.setTransform(...transforms[orientation]);
		context.drawImage(image, 0, 0);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.95));
		if (!blob || blob.size === 0 || blob.type !== type) throw new Error("SOURCE_IMAGE_UNREADABLE");
		return new File([blob], heic ? original.name.replace(/\.[^.]+$/, "") + ".png" : original.name, {
			type,
			lastModified: original.lastModified,
		});
	} catch (error) {
		if (error instanceof Error && error.message === "SOURCE_IMAGE_DIMENSIONS_TOO_LARGE")
			throw error;
		throw new Error(heic ? "SOURCE_IMAGE_HEIC_UNSUPPORTED" : "SOURCE_IMAGE_UNREADABLE");
	} finally {
		URL.revokeObjectURL(url);
		canvas.width = 0;
		canvas.height = 0;
	}
}
