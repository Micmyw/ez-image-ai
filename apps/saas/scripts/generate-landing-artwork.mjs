import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

import sharp from "sharp";

const app = new URL("../", import.meta.url);
const prefix = "/images/landing/variants/";
const directory = new URL(`public${prefix}`, app);
const featured = ["gpt-2-moon-cinema", "nano-pro-glass-perfume", "seedream-lite-kingfisher"];
const examples = (await readdir(new URL("public/examples/", app)))
	.filter((name) => /^case-[a-z-]+\.webp$/.test(name))
	.sort();
const sources = [
	...featured.map((key) => ({ src: `/images/models/${key}.webp`, crop: false })),
	...examples.map((name) => ({ src: `/examples/${name}`, crop: false })),
];
const generated = {};
let totalBytes = 0;
await mkdir(directory, { recursive: true });

for (const { src, crop } of sources) {
	const source = await readFile(new URL(`public${src}`, app));
	const metadata = await sharp(source).metadata();
	if (!metadata.width || !metadata.height) throw new Error(`Missing image dimensions: ${src}`);
	const width = metadata.width;
	const height = crop ? Math.round((width * 3) / 4) : metadata.height;
	const variants = [];
	for (const targetWidth of [240, 384, 480, 640, 768, 960].filter((size) => size <= width)) {
		const bytes = await sharp(source)
			.resize({
				width: targetWidth,
				...(crop ? { height: (targetWidth * 3) / 4, fit: "cover", position: "centre" } : {}),
				withoutEnlargement: true,
			})
			.webp({ quality: 72, effort: 5 })
			.toBuffer();
		const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
		const key = src
			.split("/")
			.at(-1)
			.replace(/\.webp$/, "");
		const filename = `${key}-${targetWidth}.${digest}.webp`;
		await writeFile(new URL(filename, directory), bytes);
		variants.push({ width: targetWidth, src: `${prefix}${filename}` });
		totalBytes += bytes.length;
	}
	generated[src] = {
		sourceHash: createHash("sha256").update(source).digest("hex"),
		width,
		height,
		variants,
	};
}

await writeFile(
	new URL("modules/landing/lib/landing-artwork-variants.json", app),
	`${JSON.stringify(generated, null, "\t")}\n`,
);
console.log(JSON.stringify({ artworks: sources.length, totalBytes }));
