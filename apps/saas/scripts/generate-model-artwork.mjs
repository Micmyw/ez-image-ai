import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const app = new URL("../", import.meta.url);
const root = new URL("../../../", import.meta.url);
const sourceManifest = JSON.parse(
	await readFile(new URL("docs/product/model-artwork.json", root), "utf8"),
);
const publicPrefix = "/images/models/variants/";
const directory = new URL(`public${publicPrefix}`, app);
const widths = [320, 480, 640, 960, 1280];
const generated = {};
let totalBytes = 0;
let fileCount = 0;

await mkdir(directory, { recursive: true });
for (const asset of sourceManifest.assets) {
	if (!/^[a-z0-9-]+$/.test(asset.key)) throw new Error(`Invalid artwork key: ${asset.key}`);
	const source = await readFile(new URL(`public/images/models/${asset.key}.webp`, app));
	const { width, height } = await sharp(source).metadata();
	if (width !== asset.width || height !== asset.height) {
		throw new Error(`Artwork dimensions changed: ${asset.key}`);
	}
	const variants = [];
	for (const targetWidth of [...widths.filter((size) => size < width), width]) {
		// Preserve the original bytes at full size; smaller versions keep the entire composition.
		const bytes =
			targetWidth === width
				? source
				: await sharp(source)
						.resize({ width: targetWidth, withoutEnlargement: true })
						.webp({ quality: 82, effort: 4 })
						.toBuffer();
		const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
		const filename = `${asset.key}-${targetWidth}.${digest}.webp`;
		await writeFile(new URL(filename, directory), bytes);
		variants.push({ width: targetWidth, src: `${publicPrefix}${filename}` });
		totalBytes += bytes.length;
		fileCount++;
	}
	generated[asset.key] = {
		sourceHash: createHash("sha256").update(source).digest("hex"),
		width,
		height,
		variants,
	};
}

const output = new URL("modules/models/lib/model-artwork-variants.json", app);
await writeFile(output, `${JSON.stringify(generated, null, "\t")}\n`);
console.log(
	JSON.stringify({
		artworks: sourceManifest.assets.length,
		fileCount,
		totalBytes,
		manifest: fileURLToPath(output),
	}),
);
