import { describe, expect, it, vi } from "vitest";

import { createPaymentActionController } from "./payment-action";
import { parseUpgradeSelection, upgradeHref } from "./upgrade-selection";

describe("payment admission across visible checkout controls", () => {
	it("rejects same-tick clicks on the same plan, a different plan and credit packs", () => {
		const gate = createPaymentActionController();
		const notify = vi.fn();
		gate.subscribe(notify);
		expect(gate.acquire("plan:creator")).toBe(true);
		expect(gate.acquire("plan:creator")).toBe(false);
		expect(gate.acquire("plan:studio")).toBe(false);
		expect(gate.acquire("pack:credits-1500:paypal")).toBe(false);
		expect(notify).toHaveBeenCalledTimes(1);
	});
	it("keeps checkout locked while navigating and permits another attempt after an explicit reset", () => {
		const gate = createPaymentActionController();
		gate.acquire("plan:ultimate");
		gate.redirecting();
		expect(gate.getSnapshot()).toEqual({ key: "plan:ultimate", stage: "redirecting" });
		expect(gate.acquire("plan:ultimate")).toBe(false);
		gate.release();
		expect(gate.acquire("plan:ultimate")).toBe(true);
	});
});

describe("selected plan handoff after sign-in", () => {
	it("round-trips the exact public plan and interval", () => {
		const href = upgradeHref({ planId: "studio", interval: "month" }, "fr");
		expect(href).toBe("/pricing?plan=studio&interval=month&lang=fr");
		expect(parseUpgradeSelection(new URL(href, "https://example.com").searchParams)).toEqual({
			planId: "studio",
			interval: "month",
			view: "plans",
		});
	});
	it("does not open checkout for arbitrary product or provider identifiers", () => {
		expect(
			parseUpgradeSelection(new URLSearchParams("plan=provider-price-id&interval=month")),
		).toBeNull();
	});
});
