import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const capabilityMocks = vi.hoisted(() => ({ loadGuestCapabilitySnapshot: vi.fn() }));

vi.mock("../lib/guest-capability", () => capabilityMocks);

import { getGuestCapability } from "./get-guest-capability";

describe("getGuestCapability", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capabilityMocks.loadGuestCapabilitySnapshot.mockResolvedValue({
			version: "guest-v1",
			enabled: true,
			reason: null,
			upload: {
				mimeTypes: ["image/jpeg", "image/png", "image/webp"],
				maximumBytes: 10 * 1024 * 1024,
			},
			products: [
				{
					key: "image-nano-banana-2-lite",
					label: "Nano Banana 2 Lite",
					description: "Everyday private edits",
					credits: "5",
					accessHint: "guest-trial",
					aspectRatios: ["auto", "1:1", "16:9"],
					skuMatrix: {
						defaultSkuKey: "nano-banana-2-lite-1k",
						dimensions: [
							{ key: "resolution", label: "Resolution", options: [{ key: "1k", label: "1K" }] },
						],
						cells: [
							{
								skuKey: "nano-banana-2-lite-1k",
								label: "1K",
								parameterValues: { resolution: "1k" },
								credits: 5,
								aspectRatios: ["auto", "1:1", "16:9"],
								controls: [],
							},
						],
					},
				},
				{
					key: "image-gpt-image-2",
					label: "GPT Image 2",
					description: "Higher fidelity private edits",
					credits: "7",
					accessHint: "paid-account",
					aspectRatios: ["auto", "1:1", "16:9"],
					skuMatrix: {
						defaultSkuKey: "gpt-image-2-1k",
						dimensions: [
							{
								key: "resolution",
								label: "Resolution",
								options: [
									{ key: "1k", label: "1K" },
									{ key: "4k", label: "4K" },
								],
							},
						],
						cells: [
							{
								skuKey: "gpt-image-2-1k",
								label: "1K",
								parameterValues: { resolution: "1k" },
								credits: 7,
								aspectRatios: ["auto", "1:1", "16:9"],
								controls: [
									{
										key: "background",
										label: "Background",
										defaultValue: "opaque",
										options: [
											{ key: "auto", label: "Auto" },
											{ key: "opaque", label: "Opaque" },
											{ key: "transparent", label: "Transparent" },
										],
									},
								],
							},
							{
								skuKey: "gpt-image-2-4k",
								label: "4K",
								parameterValues: { resolution: "4k" },
								credits: 17,
								aspectRatios: ["16:9"],
								controls: [],
							},
						],
					},
				},
			],
			queueEstimate: { kind: "capacity" },
		});
	});

	it("accepts the canonical credit values and public aspect-ratio contract", async () => {
		const responseHeaders = new Headers();
		const result = await call(getGuestCapability, undefined, {
			context: { headers: new Headers(), responseHeaders },
		});

		expect(result.products.map((product) => product.credits)).toEqual(["5", "7"]);
		expect(result.products[0]?.aspectRatios).toContain("16:9");
		expect(result.products[1]?.skuMatrix.cells[0]?.controls).toEqual([
			expect.objectContaining({
				key: "background",
				defaultValue: "opaque",
			}),
		]);
		expect(JSON.stringify(result)).not.toMatch(/provider|modelId|costMicros/i);
		expect(responseHeaders.get("Cache-Control")).toBe("no-store");
	});
});
