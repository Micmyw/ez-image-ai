import { getPublicConfig } from "@repo/config/client";

const preparedFiles = new WeakMap<File, Promise<File>>();
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

/** Finish preparation before allocating an immutable upload identity or hashing its bytes. */
export async function prepareImageUpload(
	file: File,
	maximumBytes = getPublicConfig().uploadLimits.imageBytes,
): Promise<File> {
	if (file.type !== "image/png") return file;
	if (file.size > maximumBytes) throw new Error("SOURCE_IMAGE_TOO_LARGE");
	let prepared = preparedFiles.get(file);
	if (!prepared) {
		prepared = repairTruncatedPng(file).catch((error: unknown) => {
			preparedFiles.delete(file);
			throw error;
		});
		preparedFiles.set(file, prepared);
	}
	const result = await prepared;
	if (result.size > maximumBytes) throw new Error("SOURCE_IMAGE_TOO_LARGE");
	return result;
}

async function repairTruncatedPng(file: File): Promise<File> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	// Other invalid input still goes through the existing server-side format validation.
	if (!pngSignature.every((value, index) => bytes[index] === value)) return file;
	const view = new DataView(bytes.buffer);
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset);
		const type = view.getUint32(offset + 4);
		if (offset + length + 12 > bytes.length) break;
		if (type === 0x49454e44 && length === 0) return file; // IEND
		offset += length + 12;
	}
	if (bytes.length < 33 || view.getUint32(12) !== 0x49484452)
		throw new Error("SOURCE_IMAGE_UNREADABLE"); // IHDR
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	// Bound decoding and canvas allocation before touching a possibly damaged image.
	if (!width || !height || width > 16_384 || height > 16_384 || width * height > 100_000_000)
		throw new Error("SOURCE_IMAGE_UNREADABLE");
	const image = new Image();
	const url = URL.createObjectURL(file);
	const canvas = document.createElement("canvas");
	try {
		image.src = url;
		await image.decode();
		if (!image.naturalWidth || !image.naturalHeight) throw new Error("SOURCE_IMAGE_UNREADABLE");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("SOURCE_IMAGE_UNREADABLE");
		context.drawImage(image, 0, 0);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		if (!blob || blob.size === 0 || blob.type !== "image/png")
			throw new Error("SOURCE_IMAGE_UNREADABLE");
		return new File([blob], file.name, { type: "image/png", lastModified: file.lastModified });
	} catch {
		throw new Error("SOURCE_IMAGE_UNREADABLE");
	} finally {
		URL.revokeObjectURL(url);
		canvas.width = 0;
		canvas.height = 0;
	}
}
