import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getGenerationDurationEstimate: vi.fn() }));
vi.mock("@repo/database/media-generation-duration", () => mocks);
vi.mock("@repo/database/client", () => ({
	db: {},
	runWithDatabaseClientConstructionObserver: vi.fn(),
}));

import { getGenerationDuration } from "./get-generation-duration";

const input = { productKey: "image-nano-banana-2-lite", skuKey: "nano-banana-2-lite-1k" } as const;
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("MEDIA_ENABLED_PROVIDERS", "kie");
	mocks.getGenerationDurationEstimate.mockResolvedValue({ kind: "processing" });
});
afterEach(() => vi.unstubAllEnvs());

describe("getGenerationDuration", () => {
	it("reads only a public selection and caches its aggregate separately from generation", async () => {
		const responseHeaders = new Headers();
		expect(
			await call(getGenerationDuration, input, {
				context: { headers: new Headers(), responseHeaders },
			}),
		).toEqual({ kind: "processing" });
		expect(mocks.getGenerationDurationEstimate).toHaveBeenCalledWith(
			{ ...input, serviceClass: "STANDARD" },
			{},
		);
		expect(responseHeaders.get("Cache-Control")).toBe("public, max-age=120");
	});
	it("does not expose duration numbers from development or mock mode", async () => {
		vi.stubEnv("NODE_ENV", "development");
		expect(
			await call(getGenerationDuration, input, { context: { headers: new Headers() } }),
		).toEqual({ kind: "processing" });
		expect(mocks.getGenerationDurationEstimate).not.toHaveBeenCalled();
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("MEDIA_ENABLED_PROVIDERS", "");
		expect(
			await call(getGenerationDuration, input, { context: { headers: new Headers() } }),
		).toEqual({ kind: "processing" });
		expect(mocks.getGenerationDurationEstimate).not.toHaveBeenCalled();
	});
	it("returns no seconds when the aggregate read fails", async () => {
		mocks.getGenerationDurationEstimate.mockRejectedValue(new Error("private database detail"));
		const responseHeaders = new Headers();
		expect(
			await call(getGenerationDuration, input, {
				context: { headers: new Headers(), responseHeaders },
			}),
		).toEqual({ kind: "processing" });
		expect(responseHeaders.get("Cache-Control")).toBe("no-store");
	});
	it.each([
		["kie", 1],
		["mock", 0],
		["unsupported-provider", 0],
	] as const)(
		"validates legacy adapter %s without ambient ProcessEnv types",
		async (adapter, expectedReads) => {
			vi.stubEnv("MEDIA_ENABLED_PROVIDERS", undefined);
			vi.stubEnv("MEDIA_PROVIDER_ADAPTER", adapter);
			expect(
				await call(getGenerationDuration, input, { context: { headers: new Headers() } }),
			).toEqual({ kind: "processing" });
			expect(mocks.getGenerationDurationEstimate).toHaveBeenCalledTimes(expectedReads);
		},
	);
	it("rejects identifiers and mismatched SKUs before executing a read", async () => {
		await expect(
			call(
				getGenerationDuration,
				{ ...input, skuKey: "gpt-image-2-1k" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toThrow();
		await expect(
			call(getGenerationDuration, { ...input, userId: "private-owner" } as never, {
				context: { headers: new Headers() },
			}),
		).rejects.toThrow();
		expect(mocks.getGenerationDurationEstimate).not.toHaveBeenCalled();
	});
});
