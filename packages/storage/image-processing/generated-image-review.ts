import { renderStaticSvg } from "#svg-rasterizer";

import { validateStaticSvg } from "./static-svg";

export async function svgReviewPng(bytes: Uint8Array): Promise<Uint8Array> {
	return renderStaticSvg(validateStaticSvg(bytes));
}

export { gifReviewPng } from "./generated-gif";
