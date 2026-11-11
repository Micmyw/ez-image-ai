import { initWasm, Resvg } from "@resvg/resvg-wasm";

import { MediaValidationError } from "../lib/media-signatures";
import { svgWasm } from "./svg-wasm-worker";

const SIDE = 1568;
let initialized: Promise<void> | undefined;

export async function renderStaticSvg(svg: {
	source: string;
	width: number;
	height: number;
}): Promise<Uint8Array> {
	initialized ??= svgWasm().then((module) => initWasm(module));
	await initialized;
	const renderer = new Resvg(svg.source, {
		fitTo: { mode: svg.width >= svg.height ? "width" : "height", value: SIDE },
		background: "#ffffff",
	});
	let rendered: ReturnType<InstanceType<typeof Resvg>["render"]> | undefined;
	try {
		if (renderer.imagesToResolve().length)
			throw new MediaValidationError(
				"OUTPUT_MEDIA_TYPE_UNSUPPORTED",
				"SVG contains an external image",
			);
		rendered = renderer.render();
		if (!rendered.width || !rendered.height || rendered.width > SIDE || rendered.height > SIDE)
			throw new MediaValidationError("OUTPUT_MEDIA_SIZE_EXCEEDED", "SVG render size is invalid");
		return rendered.asPng().slice();
	} finally {
		rendered?.free();
		renderer.free();
	}
}
