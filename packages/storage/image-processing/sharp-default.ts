import { createSharpImageProcessor } from "./sharp";

const processor = createSharpImageProcessor();

export function getDefaultImageProcessor() {
	return processor;
}
