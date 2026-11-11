import sharp from "sharp";

/** Reuse the existing Node image processor; only Workers need an additional WASM module. */
export async function renderStaticSvg(svg: {
	source: string;
	width: number;
	height: number;
}): Promise<Uint8Array> {
	return sharp(Buffer.from(svg.source), { failOn: "error", limitInputPixels: 100_000_000 })
		.resize({ width: 1568, height: 1568, fit: "inside" })
		.flatten({ background: "#ffffff" })
		.png()
		.toBuffer();
}
