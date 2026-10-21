import { describe, expect, it, vi } from "vitest";
const track = vi.hoisted(() => vi.fn().mockResolvedValue("sent"));
vi.mock("@repo/utils/lib/growth-analytics-browser", () => ({ trackBrowserGrowthEvent: track }));
import { trackCheckoutStage } from "./conversion";

describe("checkout observations", () => {
	it.each(["PLAN", "CREDIT_PACK", "IMAGE_PASS"] as const)(
		"tracks %s without storing error text or payment identifiers",
		(kind) => {
			trackCheckoutStage("purchase_clicked", kind);
			trackCheckoutStage(
				"checkout_failed",
				kind,
				Object.assign(new Error("private provider response"), { code: "CONFLICT" }),
			);
			expect(track).toHaveBeenLastCalledWith({
				name: "checkout_failed",
				properties: { productKind: kind, errorCategory: "conflict" },
			});
			expect(JSON.stringify(track.mock.calls)).not.toContain("private provider response");
		},
	);
	it("analytics rejection cannot reject the purchase action", async () => {
		track.mockRejectedValueOnce(new Error("offline"));
		expect(() => trackCheckoutStage("checkout_requested", "PLAN")).not.toThrow();
		await Promise.resolve();
	});
});
