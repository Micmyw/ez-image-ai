import { createExecutableRouteGraph, getPublicProductCatalog } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/ai", async (importOriginal) => {
	const ai = await importOriginal<typeof import("@repo/ai")>();
	return { ...ai, getPublicProductCatalog: vi.fn(ai.getPublicProductCatalog) };
});

import {
	getCurrentExecutableRouteGraphOptions,
	getCurrentPublicCatalogProjection,
} from "./executable-route-graph";

const ENVIRONMENT = {
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie,fal",
};

describe("current executable media route graph", () => {
	it("keeps configured routes visible to an API process without worker credentials", async () => {
		const options = await getCurrentExecutableRouteGraphOptions(
			{ runtimeConfigOverride: { findMany: async () => [] } } as never,
			ENVIRONMENT,
		);

		expect(createExecutableRouteGraph(options).getEntry("image-nano-banana-2-lite")).toBeDefined();
	});

	it("removes a model disabled by an active database override before it is advertised or quoted", async () => {
		const findMany = vi.fn(async () => [{ configKey: "media.model.image-gpt-image-2.enabled" }]);
		const options = await getCurrentExecutableRouteGraphOptions(
			{ runtimeConfigOverride: { findMany } } as never,
			ENVIRONMENT,
		);

		expect(findMany).toHaveBeenCalledOnce();
		expect(createExecutableRouteGraph(options).getEntry("image-gpt-image-2")).toBeUndefined();
		expect(createExecutableRouteGraph(options).getEntry("image-nano-banana-2-lite")).toBeDefined();
		expect(createExecutableRouteGraph(options).getEntry("video-fast")).toBeDefined();
	});

	it("removes every product when the global database kill switch is active", async () => {
		const options = await getCurrentExecutableRouteGraphOptions(
			{
				runtimeConfigOverride: {
					findMany: async () => [{ configKey: "media.generation.enabled" }],
				},
			} as never,
			ENVIRONMENT,
		);

		expect(createExecutableRouteGraph(options).entries).toEqual([]);
	});

	it("shares one public projection across reads with equal current switches", async () => {
		const findMany = vi.fn(async () => []);
		const database = { runtimeConfigOverride: { findMany } } as never;
		const [catalogRead, uploadRead] = await Promise.all([
			getCurrentPublicCatalogProjection(database, ENVIRONMENT),
			getCurrentPublicCatalogProjection(database, {
				...ENVIRONMENT,
				MEDIA_ENABLED_PROVIDERS: "fal,kie",
			}),
		]);

		expect(findMany).toHaveBeenCalledTimes(2);
		expect(getPublicProductCatalog).toHaveBeenCalledOnce();
		expect(catalogRead).toBe(uploadRead);
		const image = catalogRead.ezPicProducts.find((product) => product.key === "image-gpt-image-2");
		if (!image) throw new Error("Expected the shared GPT Image 2 matrix");
		expect(image.skuMatrix).toBe(
			catalogRead.catalog.products.find((product) => product.key === image.key)?.skuMatrix,
		);
		const aspects = image.skuMatrix.cells[0]?.aspectRatios;
		const controlOptions = image.skuMatrix.cells[0]?.controls[0]?.options;
		const resolutionOption = image.skuMatrix.dimensions[0]?.options[0];
		expect(aspects?.length).toBeGreaterThan(0);
		expect(controlOptions?.length).toBeGreaterThan(0);
		expect(resolutionOption?.key).toBe("1k");
		expect(Object.isFrozen(aspects)).toBe(true);
		expect(Object.isFrozen(controlOptions)).toBe(true);
		expect(Object.isFrozen(resolutionOption)).toBe(true);
	});

	it("revalidates overrides even with a warm projection and revises only changed public data", async () => {
		const findMany = vi.fn<() => Promise<Array<{ configKey: string }>>>().mockResolvedValue([]);
		const database = { runtimeConfigOverride: { findMany } } as never;
		const enabled = await getCurrentPublicCatalogProjection(database, ENVIRONMENT);
		findMany.mockResolvedValueOnce([{ configKey: "media.model.image-gpt-image-2.enabled" }]);
		const disabled = await getCurrentPublicCatalogProjection(database, ENVIRONMENT);
		expect(disabled.catalog.revision).not.toBe(enabled.catalog.revision);
		expect(disabled.catalog.products).not.toContainEqual(
			expect.objectContaining({ key: "image-gpt-image-2" }),
		);
		expect(disabled.ezPicProducts).not.toContainEqual(
			expect.objectContaining({ key: "image-gpt-image-2" }),
		);

		findMany.mockResolvedValueOnce([{ configKey: "media.generation.enabled" }]);
		const killed = await getCurrentPublicCatalogProjection(database, ENVIRONMENT);
		expect(killed.catalog.products).toEqual([]);
		expect(killed.ezPicProducts).toEqual([]);
		expect(killed.catalog.revision).not.toBe(disabled.catalog.revision);

		findMany.mockRejectedValueOnce(new Error("database unavailable"));
		await expect(getCurrentPublicCatalogProjection(database, ENVIRONMENT)).rejects.toThrow(
			"database unavailable",
		);
		expect((await getCurrentPublicCatalogProjection(database, ENVIRONMENT)).catalog.revision).toBe(
			enabled.catalog.revision,
		);
	});
});
