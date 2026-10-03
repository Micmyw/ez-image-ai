const MAXIMUM_BYTES = 10 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

/** Read only a freshly authorized result; keep the normal upload size/type limits. */
export async function readColoringSourceImage(
	url: string,
	{ signal, fetcher = fetch }: { signal: AbortSignal; fetcher?: typeof fetch },
): Promise<File> {
	const response = await fetcher(url, {
		signal,
		credentials: "omit",
		cache: "no-store",
		referrerPolicy: "no-referrer",
	});
	const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
	const extension = EXTENSIONS[mimeType];
	if (
		!response.ok ||
		!extension ||
		Number(response.headers.get("content-length")) > MAXIMUM_BYTES ||
		!response.body
	) {
		await response.body?.cancel();
		throw new Error("COLORING_SOURCE_UNAVAILABLE");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let bytes = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAXIMUM_BYTES) throw new Error("COLORING_SOURCE_TOO_LARGE");
			chunks.push(new Uint8Array(value));
		}
		if (!bytes) throw new Error("COLORING_SOURCE_EMPTY");
		return new File(chunks, `selected-image.${extension}`, { type: mimeType });
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}
