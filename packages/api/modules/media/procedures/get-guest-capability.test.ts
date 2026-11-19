import { call } from "@orpc/server";
import {
	GUEST_CAPABILITY_CATALOG_PRESENTATION,
	GUEST_CAPABILITY_PRESENTATION_HEADER,
} from "@repo/config/guest-trial";
import { runWithCloudflareFreeEligibility } from "@repo/utils/free-eligibility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capabilityMocks = vi.hoisted(() => ({ loadGuestCapability: vi.fn() }));

vi.mock("../lib/guest-capability", () => capabilityMocks);

import { getGuestCapability } from "./get-guest-capability";

describe("getGuestCapability", () => {
	afterEach(() => vi.unstubAllEnvs());
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("BETTER_AUTH_SECRET", "capability-handshake-secret-longer-than-32");
		const snapshot = {
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
		};
		capabilityMocks.loadGuestCapability.mockResolvedValue({
			snapshot,
			catalogRevision: "a".repeat(64),
		});
	});

	it.each([
		["US", null],
		["CA", null],
		["GB", null],
		["FR", null],
		["CN", "REGION_EXCLUDED"],
		["BR", "REGION_EXCLUDED"],
		["IN", "REGION_EXCLUDED"],
		[undefined, "REGION_UNVERIFIED"],
	])(
		"advertises only trusted region eligibility for %s while preserving account uploads",
		async (country, reason) => {
			const responseHeaders = new Headers();
			const result = await runWithCloudflareFreeEligibility(country, () =>
				call(getGuestCapability, undefined, {
					context: { headers: new Headers({ "cf-ipcountry": "US" }), responseHeaders },
				}),
			);
			expect(result).toMatchObject({ enabled: true, reason, version: "guest-v1" });
			if (!("products" in result)) throw new Error("Expected the existing full capability");
			expect(result.products).toHaveLength(2);
			expect(responseHeaders.get("Cache-Control")).toBe("no-store");
		},
	);

	it("accepts the canonical credit values and public aspect-ratio contract", async () => {
		const responseHeaders = new Headers();
		const result = await call(getGuestCapability, undefined, {
			context: { headers: new Headers(), responseHeaders },
		});

		if (!("products" in result)) throw new Error("Expected the existing full capability");
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
		expect(responseHeaders.get("set-cookie")).toContain("HttpOnly");
	});

	it("advertises a catalog revision only to opted-in clients, with the same private handshake", async () => {
		const headers = new Headers({
			[GUEST_CAPABILITY_PRESENTATION_HEADER]: GUEST_CAPABILITY_CATALOG_PRESENTATION,
		});
		const responseHeaders = new Headers();
		const compact = await runWithCloudflareFreeEligibility("IN", () =>
			call(getGuestCapability, undefined, { context: { headers, responseHeaders } }),
		);
		const issuedCookie = responseHeaders.get("set-cookie");
		expect(issuedCookie).toContain("HttpOnly");
		const fallbackHeaders = new Headers();
		const full = await runWithCloudflareFreeEligibility("IN", () =>
			call(getGuestCapability, undefined, {
				context: {
					headers: new Headers({ cookie: issuedCookie!.split(";")[0]! }),
					responseHeaders: fallbackHeaders,
				},
			}),
		);
		if (!("products" in full)) throw new Error("Expected the existing full capability");
		const { products, ...details } = full;
		expect(products).toHaveLength(2);
		expect(compact).toEqual({ ...details, catalogRevision: "a".repeat(64) });
		expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 2);
		expect(compact).toMatchObject({
			enabled: true,
			reason: "REGION_EXCLUDED",
			version: "guest-v1",
		});
		expect(responseHeaders.get("Cache-Control")).toBe("no-store");
		expect(fallbackHeaders.get("Cache-Control")).toBe("no-store");
		expect(fallbackHeaders.has("set-cookie")).toBe(false);
	});
});
