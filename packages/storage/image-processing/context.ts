import { AsyncLocalStorage } from "node:async_hooks";

import { getDefaultImageProcessor } from "#image-processor-default";

import type { ImageProcessor } from "./types";

// Next's server bundle and the Worker entry can contain separate module copies.
// They must still read the same request-local processor, never a mutable global binding.
const contextKey = Symbol.for("ezpic.storage.image-processor.v1");
const contextGlobals = globalThis as typeof globalThis & {
	[contextKey]?: AsyncLocalStorage<ImageProcessor>;
};
const processorContext = (contextGlobals[contextKey] ??= new AsyncLocalStorage<ImageProcessor>());

export function getImageProcessor(): ImageProcessor {
	return processorContext.getStore() ?? getDefaultImageProcessor();
}

export function runWithImageProcessor<T>(processor: ImageProcessor, callback: () => T): T {
	return processorContext.run(processor, callback);
}
