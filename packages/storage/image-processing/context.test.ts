import { describe, expect, it, vi } from "vitest";

import { getImageProcessor, runWithImageProcessor } from "./context";
import type { ImageProcessor } from "./types";
import { getDefaultImageProcessor as getWorkerDefault } from "./worker-default";

function processor(key: string): ImageProcessor {
	return {
		key,
		inspect: async () => ({ width: 640, height: 400 }),
		watermark: async (source) => source,
	};
}

describe("request-scoped image processor", () => {
	it("keeps concurrent and nested requests isolated and restores the default", async () => {
		let finishFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		const first = runWithImageProcessor(processor("first"), async () => {
			await firstGate;
			const nested = runWithImageProcessor(processor("nested"), () => getImageProcessor().key);
			return [getImageProcessor().key, nested];
		});
		const second = runWithImageProcessor(processor("second"), async () => {
			await Promise.resolve();
			finishFirst();
			return getImageProcessor().key;
		});
		expect(await first).toEqual(["first", "nested"]);
		expect(await second).toBe("second");
		expect(getImageProcessor().key).toBe("sharp");
	});

	it("shares the same request context between separately loaded bundles", async () => {
		vi.resetModules();
		const secondBundle = await import("./context");
		expect(
			runWithImageProcessor(processor("injected"), () => secondBundle.getImageProcessor().key),
		).toBe("injected");
	});

	it("restores the previous context after a rejected operation", async () => {
		await expect(
			runWithImageProcessor(processor("failed"), async () => {
				throw new Error("transform failed");
			}),
		).rejects.toThrow("transform failed");
		expect(getImageProcessor().key).toBe("sharp");
	});

	it("fails closed in Workers without an injected binding", () => {
		expect(() => getWorkerDefault()).toThrow("IMAGE_PROCESSOR_BINDING_REQUIRED");
	});
});
