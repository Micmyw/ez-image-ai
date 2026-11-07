const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
export const TEMPLATE_PHOTO_SOURCE_LIMIT = 40 * 1024 * 1024;

/** Prepare final bytes before requesting an immutable upload session. Small files stay untouched. */
export async function prepareTemplatePhoto(file: File, maximumBytes: number): Promise<File> {
	if (!acceptedTypes.has(file.type) || file.size === 0) throw new Error("PHOTO_FORMAT_UNSUPPORTED");
	if (file.size > TEMPLATE_PHOTO_SOURCE_LIMIT) throw new Error("PHOTO_SOURCE_TOO_LARGE");
	if (!Number.isFinite(maximumBytes) || maximumBytes <= 0)
		throw new Error("PHOTO_PREPARATION_FAILED");
	if (file.size <= maximumBytes) return file;

	const image = new Image();
	const url = URL.createObjectURL(file);
	const canvas = document.createElement("canvas");
	try {
		image.src = url;
		await image.decode();
		const { naturalWidth: width, naturalHeight: height } = image;
		// Bound canvas allocation, including unusually large decoded phone panoramas.
		if (!width || !height || width > 16_384 || height > 16_384 || width * height > 64_000_000)
			throw new Error("PHOTO_PREPARATION_FAILED");
		const context = canvas.getContext("2d");
		if (!context) throw new Error("PHOTO_PREPARATION_FAILED");
		const initialScale = Math.min(1, 2560 / Math.max(width, height));
		for (const scale of [initialScale, initialScale * 0.75, initialScale * 0.5]) {
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			context.drawImage(image, 0, 0, canvas.width, canvas.height);
			for (const quality of [0.9, 0.8, 0.7]) {
				// WebP preserves transparency; never silently flatten PNGs onto a black background.
				const blob = await new Promise<Blob | null>((resolve) =>
					canvas.toBlob(resolve, "image/webp", quality),
				);
				if (!blob || blob.size === 0 || !acceptedTypes.has(blob.type))
					throw new Error("PHOTO_PREPARATION_FAILED");
				if (blob.size <= maximumBytes) {
					const extension =
						blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
					return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.${extension}`, {
						type: blob.type,
						lastModified: file.lastModified,
					});
				}
			}
		}
		throw new Error("PHOTO_PREPARATION_FAILED");
	} catch {
		throw new Error("PHOTO_PREPARATION_FAILED");
	} finally {
		URL.revokeObjectURL(url);
		canvas.width = 0;
		canvas.height = 0;
	}
}
