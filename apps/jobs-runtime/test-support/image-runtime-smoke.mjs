import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Execute inside the built jobs image. Host tests can have fonts that the
// deployed Linux image lacks, silently leaving only the watermark's plate.
const require = createRequire(new URL("../../../packages/storage/package.json", import.meta.url));
const sharp = require("sharp");
const { getImageProcessor } = require("./image-processing/context.ts");
const { guestWatermarkGeometry } = require("./image-processing/geometry.ts");
const { createRuntimeDatabaseClient } = require("../database/prisma/client.ts");
require("../jobs/src/orchestration/executor.ts");
const database = createRuntimeDatabaseClient("postgresql://unused:unused@127.0.0.1:1/unused");
await database.$disconnect();
assert.equal(process.getuid(), 1000, "The jobs image must run as the unprivileged node user");

const processor = getImageProcessor();
assert.equal(processor.key, "sharp");
const input = await sharp({
	create: { width: 1024, height: 768, channels: 4, background: "#eeeeee" },
})
	.png()
	.toBuffer();
const source = () =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(input);
			controller.close();
		},
	});
assert.deepEqual(await processor.inspect(source(), "image/png"), { width: 1024, height: 768 });
const result = await processor.watermark(source(), {
	width: 1024,
	height: 768,
	contentType: "image/png",
	contentLength: input.length,
});
const output = Buffer.from(await new Response(result).arrayBuffer());
const { left, top, plateWidth, plateHeight } = guestWatermarkGeometry(1024, 768);
const pixels = await sharp(output)
	.extract({ left: left + 6, top: top + 6, width: plateWidth - 12, height: plateHeight - 12 })
	.removeAlpha()
	.raw()
	.toBuffer();
let letteringPixels = 0;
for (let index = 0; index < pixels.length; index += 3) {
	if (pixels[index] > 245 && pixels[index + 1] > 245 && pixels[index + 2] > 245) {
		letteringPixels++;
	}
}
assert(
	letteringPixels > 50,
	"Sharp rendered a plate without visible EzPic lettering; check image fonts",
);
process.stdout.write(
	JSON.stringify({
		nodePrismaImported: true,
		handlersImported: true,
		processor: processor.key,
		watermarkedImageBytes: output.length,
		letteringPixels,
		uid: process.getuid(),
	}) + "\n",
);
