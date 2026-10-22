import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const LEGACY_SCANLESS_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
	"base64",
);

const profiles = {
	"png-512k": { targetBytes: 512 * 1024, width: 512 },
	"png-1m": { targetBytes: 1024 * 1024, width: 768 },
	"png-4m": { targetBytes: 4 * 1024 * 1024, width: 1536 },
	"png-10m": { targetBytes: 10 * 1024 * 1024, width: 2560 },
} as const;

/** Test bytes only: actual RGB pixels and valid PNG chunks, with no post-IEND padding. */
export function createScanlessOutputFixture(
	options: { profile?: string; legacyBytes?: string } = {},
) {
	const profile = options.profile ?? "legacy";
	let bytes: Buffer<ArrayBuffer>;
	let width = 1;
	let height = 1;
	if (profile === "legacy") {
		const byteLength = Number(options.legacyBytes ?? LEGACY_SCANLESS_PNG.length);
		assert(
			Number.isSafeInteger(byteLength) &&
				byteLength >= LEGACY_SCANLESS_PNG.length &&
				byteLength <= 10 * 1024 * 1024,
			"INVALID_SCANLESS_OUTPUT_BYTES",
		);
		bytes = Buffer.alloc(byteLength);
		LEGACY_SCANLESS_PNG.copy(bytes);
	} else {
		assert(options.legacyBytes === undefined, "OUTPUT_PROFILE_AND_LEGACY_BYTES_ARE_EXCLUSIVE");
		assert(Object.hasOwn(profiles, profile), "UNKNOWN_SCANLESS_OUTPUT_PROFILE");
		const dimensions = profiles[profile as keyof typeof profiles];
		width = dimensions.width;
		// Leave room for PNG/zlib framing while keeping the actual file close to
		// the selected byte budget. Every remaining byte belongs to real pixels.
		height = Math.floor((dimensions.targetBytes - 2048) / (width * 3 + 1));
		const pixels = Buffer.alloc((width * 3 + 1) * height);
		let state = 0x6d2b79f5;
		for (let y = 0; y < height; y++) {
			const row = y * (width * 3 + 1);
			pixels[row] = 0; // PNG scanline filter: none.
			for (let x = 1; x <= width * 3; x++) {
				state ^= state << 13;
				state ^= state >>> 17;
				state ^= state << 5;
				pixels[row + x] = state & 0xff;
			}
		}
		const header = Buffer.alloc(13);
		header.writeUInt32BE(width, 0);
		header.writeUInt32BE(height, 4);
		header[8] = 8;
		header[9] = 2; // RGB, no alpha/interlace.
		bytes = Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			pngChunk("IHDR", header),
			pngChunk("IDAT", deflateSync(pixels, { level: 0 })),
			pngChunk("IEND", Buffer.alloc(0)),
		]);
		assert(bytes.length <= dimensions.targetBytes, "PNG_FIXTURE_EXCEEDS_PROFILE_BUDGET");
	}
	return {
		bytes,
		metadata: {
			profile,
			width,
			height,
			encodedBytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			legacyPadded: profile === "legacy" && bytes.length > LEGACY_SCANLESS_PNG.length,
			kind: profile === "legacy" ? "legacy-one-pixel" : "deterministic-rgb-png",
		},
	};
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit++) crc = (crc & 1 ? 0xedb88320 : 0) ^ (crc >>> 1);
	return crc >>> 0;
});

function pngChunk(type: string, data: Buffer): Buffer {
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write(type, 4, 4, "ascii");
	data.copy(chunk, 8);
	let crc = 0xffffffff;
	for (let offset = 4; offset < chunk.length - 4; offset++)
		crc = crcTable[(crc ^ chunk[offset]!) & 0xff]! ^ (crc >>> 8);
	chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
	return chunk;
}
