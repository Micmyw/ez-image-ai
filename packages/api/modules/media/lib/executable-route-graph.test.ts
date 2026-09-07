import { createExecutableRouteGraph } from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { getCurrentExecutableRouteGraphOptions } from "./executable-route-graph";

const ENVIRONMENT = {
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie,fal",
	MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: DEFAULT_PRODUCT_CONFIG.catalogVersion,
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
});
