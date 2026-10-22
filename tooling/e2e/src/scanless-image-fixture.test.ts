import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { inflateSync } from "node:zlib";

import { createScanlessOutputFixture, LEGACY_SCANLESS_PNG } from "./scanless-image-fixture";

void test("retains exact legacy fixture and explicit padded boundary mode", () => {
	assert.deepEqual(createScanlessOutputFixture().bytes, LEGACY_SCANLESS_PNG);
	const padded = createScanlessOutputFixture({ legacyBytes: "10485760" });
	assert.equal(padded.bytes.length, 10 * 1024 * 1024);
	assert.equal(padded.metadata.legacyPadded, true);
	assert.equal(padded.metadata.width, 1);
	assert.throws(() => createScanlessOutputFixture({ legacyBytes: "10485761" }));
	assert.throws(() => createScanlessOutputFixture({ profile: "png-1m", legacyBytes: "1048576" }));
	assert.throws(() => createScanlessOutputFixture({ profile: "unknown" }));
});

for (const [profile, target] of [
	["png-512k", 512 * 1024],
	["png-1m", 1024 * 1024],
	["png-4m", 4 * 1024 * 1024],
	["png-10m", 10 * 1024 * 1024],
] as const) {
	void test(`${profile} is deterministic, real pixel data and valid PNG without padding`, () => {
		const { bytes, metadata } = createScanlessOutputFixture({ profile });
		assert.deepEqual(bytes, createScanlessOutputFixture({ profile }).bytes);
		assert(bytes.length <= target && bytes.length > target * 0.98);
		assert.equal(metadata.legacyPadded, false);
		let offset = 8;
		const chunks: string[] = [];
		let decoded: Buffer | undefined;
		while (offset < bytes.length) {
			const length = bytes.readUInt32BE(offset);
			const type = bytes.toString("ascii", offset + 4, offset + 8);
			chunks.push(type);
			const data = bytes.subarray(offset + 8, offset + 8 + length);
			assert.equal(
				crc32(bytes.subarray(offset + 4, offset + 8 + length)),
				bytes.readUInt32BE(offset + 8 + length),
			);
			if (type === "IHDR") {
				assert.equal(data.readUInt32BE(0), metadata.width);
				assert.equal(data.readUInt32BE(4), metadata.height);
				assert.equal(data[8], 8);
				assert.equal(data[9], 2);
			}
			if (type === "IDAT") decoded = inflateSync(data);
			offset += 12 + length;
		}
		assert.deepEqual(chunks, ["IHDR", "IDAT", "IEND"]);
		assert.equal(offset, bytes.length);
		assert(decoded);
		assert.equal(decoded.length, (metadata.width * 3 + 1) * metadata.height);
		for (let y = 0; y < metadata.height; y++)
			assert.equal(decoded[y * (metadata.width * 3 + 1)], 0);
		assert(new Set(decoded.subarray(1, 769)).size > 200, "pixels must not be a flat padded image");
	});
}
