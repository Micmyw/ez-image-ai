import { guestWatermarkGeometry } from "@repo/storage/image-processing/geometry";

/** Fetch only a public example or a URL returned by the existing media access boundary. */
export async function loadBrowserExportImage(
	url: string,
	signal?: AbortSignal,
): Promise<{ image: HTMLImageElement; dispose: () => void }> {
	const parsed = new URL(url, window.location.origin);
	if (!["http:", "https:", "blob:"].includes(parsed.protocol)) throw new Error("Invalid image URL");
	const timeout = AbortSignal.timeout(30_000);
	const response = await fetch(parsed.href, {
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		cache: "no-store",
		credentials: "omit",
		referrerPolicy: "no-referrer",
	});
	const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
	if (!response.ok || !["image/png", "image/jpeg", "image/webp"].includes(mime) || !response.body)
		throw new Error("Image unavailable");
	const reader = response.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 25 * 1024 * 1024) throw new Error("Image too large");
			chunks.push(new Uint8Array(value));
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	if (!size) throw new Error("Image unavailable");
	const objectUrl = URL.createObjectURL(new Blob(chunks, { type: mime }));
	const dispose = () => URL.revokeObjectURL(objectUrl);
	try {
		const image = new Image();
		image.src = objectUrl;
		await image.decode();
		signal?.throwIfAborted();
		if (
			!image.naturalWidth ||
			!image.naturalHeight ||
			image.naturalWidth * image.naturalHeight > 64_000_000
		)
			throw new Error("Image too large");
		return { image, dispose };
	} catch (error) {
		dispose();
		throw error;
	}
}

/** Cropping may remove the existing plate. Redraw the same guest plate after local edits. */
export function drawBrowserGuestWatermark(
	context: CanvasRenderingContext2D,
	width: number,
	height: number,
) {
	const virtualWidth = Math.max(64, width);
	const virtualHeight = Math.max(64, height);
	const geometry = guestWatermarkGeometry(virtualWidth, virtualHeight);
	context.save();
	context.scale(width / virtualWidth, height / virtualHeight);
	context.fillStyle = "rgba(17, 24, 39, 0.72)";
	context.beginPath();
	context.roundRect(
		geometry.left,
		geometry.top,
		geometry.plateWidth,
		geometry.plateHeight,
		geometry.radius,
	);
	context.fill();
	context.fillStyle = "#ffffff";
	context.font = `700 ${geometry.fontSize}px Arial, sans-serif`;
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.fillText(
		"EzImageAI",
		geometry.left + geometry.plateWidth / 2,
		geometry.top + geometry.plateHeight * 0.52,
		geometry.plateWidth * 0.9,
	);
	context.restore();
}

export async function downloadBrowserCanvas(canvas: HTMLCanvasElement, filename: string) {
	const blob = await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(
			(value) => (value ? resolve(value) : reject(new Error("Export failed"))),
			"image/png",
		),
	);
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
