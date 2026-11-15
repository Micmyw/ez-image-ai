import { imageSize } from "image-size";

/** Peek at a bounded header on the same stream; never fetch or decode the image again. */
export async function moderationImageHeader(source: ReadableStream<Uint8Array>) {
	const reader = source.getReader();
	const prefix: Uint8Array[] = [];
	const header = new Uint8Array(256 * 1024);
	let length = 0;
	let side = 1568;
	try {
		while (length < header.length) {
			const next = await reader.read();
			if (next.done) break;
			prefix.push(next.value);
			const part = next.value.subarray(0, header.length - length);
			header.set(part, length);
			length += part.length;
			try {
				const { width, height } = imageSize(header.subarray(0, length));
				if (width > 0 && height > 0) {
					// 280 squared satisfies SeeAPI's 78,400-pixel minimum. Larger
					// images retain the existing complete-frame 1568px upper bound.
					side = Math.min(1568, Math.max(280, width, height));
					break;
				}
			} catch {
				// A long/incomplete header keeps the conservative existing geometry.
				// The real decoder and complete source hash still validate the image.
			}
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
		throw error;
	}
	let position = 0;
	return {
		side,
		source: new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (position < prefix.length) {
					controller.enqueue(prefix[position++]!);
					return;
				}
				try {
					const next = await reader.read();
					if (next.done) {
						reader.releaseLock();
						controller.close();
					} else controller.enqueue(next.value);
				} catch (error) {
					reader.releaseLock();
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					reader.releaseLock();
				}
			},
		}),
	};
}
