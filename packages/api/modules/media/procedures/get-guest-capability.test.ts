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
					key: "image-fast",
					label: "Standard Edit",
					description: "Everyday private edits",
					credits: "5",
					accessHint: "guest-trial",
					aspectRatios: ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"],
				},
				{
					key: "image-quality",
					label: "Quality Edit",
					description: "Higher fidelity private edits",
					credits: "40",
					accessHint: "paid-account",
					aspectRatios: ["auto", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"],
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

		expect(result.products.map((product) => product.credits)).toEqual(["5", "40"]);
		expect(result.products[0]?.aspectRatios).toContain("16:9");
		expect(responseHeaders.get("Cache-Control")).toBe("no-store");
	});
});
