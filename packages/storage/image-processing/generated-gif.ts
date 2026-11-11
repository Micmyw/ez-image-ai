import { encode } from "fast-png";
import { decompressFrame, parseGIF } from "gifuct-js";

import { MediaValidationError } from "../lib/media-signatures";

const SIDE = 1568;

function invalidGif(): never {
	throw new MediaValidationError(
		"OUTPUT_MEDIA_TYPE_UNSUPPORTED",
		"GIF must contain 2–64 complete, bounded animation frames",
	);
}

/** Validate lengths and dimensions before invoking a decoder that allocates frame pixels. */
export function inspectGeneratedGif(bytes: Uint8Array) {
	if (
		bytes.length < 14 ||
		bytes.length > 25 * 1024 * 1024 ||
		!/^GIF8[79]a$/.test(new TextDecoder().decode(bytes.subarray(0, 6)))
	)
		invalidGif();
	const word = (position: number) => bytes[position]! | (bytes[position + 1]! << 8);
	const width = word(6);
	const height = word(8);
	if (!width || !height || width > 1024 || height > 1024) invalidGif();
	let position = 13 + (bytes[10]! & 128 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0);
	let frames = 0;
	const blocks = () => {
		for (;;) {
			if (position >= bytes.length) invalidGif();
			const length = bytes[position++]!;
			if (!length) break;
			position += length;
			if (position > bytes.length) invalidGif();
		}
	};
	while (position < bytes.length) {
		const type = bytes[position++]!;
		if (type === 0x3b) {
			if (
				position !== bytes.length ||
				frames < 2 ||
				frames > 64 ||
				width * height * frames > 64 * 1024 * 1024
			)
				invalidGif();
			return { width, height, frames };
		}
		if (type === 0x21) {
			const extension = bytes[position++]!;
			// Plain-text extensions add visual content outside decoded image frames.
			if (![0xf9, 0xfe, 0xff].includes(extension)) invalidGif();
			if (extension === 0xf9) {
				// gifuct reads the fixed GCE layout; reject alternate/truncated layouts
				// and undefined disposal modes instead of allowing decoder disagreement.
				if (
					position + 6 > bytes.length ||
					bytes[position] !== 4 ||
					bytes[position + 5] !== 0 ||
					bytes[position + 1]! & 0xe0 ||
					((bytes[position + 1]! >> 2) & 7) > 3
				)
					invalidGif();
				position += 6;
			} else {
				if (extension === 0xff && bytes[position] !== 11) invalidGif();
				blocks();
			}
		} else if (type === 0x2c) {
			if (position + 9 > bytes.length || ++frames > 64) invalidGif();
			const left = word(position),
				top = word(position + 2),
				frameWidth = word(position + 4),
				frameHeight = word(position + 6);
			if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height)
				invalidGif();
			// Browser decoders differ on undefined pixels before the first frame.
			// Require a complete first canvas so the reviewed animation is deterministic.
			if (frames === 1 && (left || top || frameWidth !== width || frameHeight !== height))
				invalidGif();
			const flags = bytes[position + 8]!;
			position += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
			const codeSize = bytes[position++]!;
			if (codeSize < 2 || codeSize > 8) invalidGif();
			blocks();
		} else invalidGif();
	}
	return invalidGif();
}

/** Every displayed frame is composited (including disposal) into one review image. */
export function gifReviewPng(bytes: Uint8Array): Uint8Array {
	const { width, height, frames: count } = inspectGeneratedGif(bytes);
	const parsed = parseGIF(Uint8Array.from(bytes).buffer);
	const frames = parsed.frames.filter(
		(frame): frame is Parameters<typeof decompressFrame>[0] => "image" in frame,
	);
	if (frames.length !== count) invalidGif();
	const columns = Math.ceil(Math.sqrt(count));
	const rows = Math.ceil(count / columns);
	const cellWidth = Math.floor(SIDE / columns),
		cellHeight = Math.floor(SIDE / rows);
	const scale = Math.min(cellWidth / width, cellHeight / height);
	const targetWidth = Math.max(1, Math.floor(width * scale)),
		targetHeight = Math.max(1, Math.floor(height * scale));
	const canvas = new Uint8Array(width * height * 4);
	const globalBackground = parsed.gct?.[parsed.lsd.backgroundColorIndex];
	const backgroundFor = (frame: Parameters<typeof decompressFrame>[0]) =>
		frame.gce?.extras.transparentColorGiven || !globalBackground
			? [0, 0, 0, 0]
			: [...globalBackground, 255];
	const initialBackground = backgroundFor(frames[0]!);
	for (let pixel = 0; pixel < canvas.length; pixel += 4) canvas.set(initialBackground, pixel);
	const sheet = new Uint8Array(SIDE * SIDE * 4).fill(255);
	for (let index = 0; index < frames.length; index++) {
		const frame = decompressFrame(frames[index]!, parsed.gct, true);
		if (
			!frame?.patch ||
			frame.patch.length !== frame.dims.width * frame.dims.height * 4 ||
			(frame.disposalType ?? 0) > 3
		)
			invalidGif();
		const previous = frame.disposalType === 3 ? canvas.slice() : undefined;
		for (let y = 0; y < frame.dims.height; y++) {
			for (let x = 0; x < frame.dims.width; x++) {
				const source = (y * frame.dims.width + x) * 4;
				if (!frame.patch[source + 3]) continue;
				const destination = ((y + frame.dims.top) * width + x + frame.dims.left) * 4;
				canvas.set(frame.patch.subarray(source, source + 4), destination);
			}
		}
		const left = (index % columns) * cellWidth + Math.floor((cellWidth - targetWidth) / 2);
		const top =
			Math.floor(index / columns) * cellHeight + Math.floor((cellHeight - targetHeight) / 2);
		for (let y = 0; y < targetHeight; y++) {
			for (let x = 0; x < targetWidth; x++) {
				const source =
					(Math.min(height - 1, Math.floor(y / scale)) * width +
						Math.min(width - 1, Math.floor(x / scale))) *
					4;
				if (canvas[source + 3])
					sheet.set(canvas.subarray(source, source + 4), ((top + y) * SIDE + left + x) * 4);
			}
		}
		if (previous) canvas.set(previous);
		else if (frame.disposalType === 2) {
			const background = backgroundFor(frames[index]!);
			for (let y = 0; y < frame.dims.height; y++) {
				const start = ((y + frame.dims.top) * width + frame.dims.left) * 4;
				for (let x = 0; x < frame.dims.width; x++) canvas.set(background, start + x * 4);
			}
		}
	}
	return encode({ width: SIDE, height: SIDE, data: sheet, channels: 4, depth: 8 });
}
