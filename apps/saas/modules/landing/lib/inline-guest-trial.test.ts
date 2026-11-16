import { describe, expect, it, vi } from "vitest";

import { prepareInlineGuestTrial } from "./inline-guest-trial";

const handoff = {
	action: "/draft/continue" as const,
	claimToken: "c".repeat(43),
	productKey: "image-minimax-h3" as const,
	skuKey: "minimax-h3-1k" as const,
	accessHint: "guest-trial" as const,
};

describe("inline guest preparation", () => {
	it("keeps the same claim in the POST body, prepares the session and claims without navigation", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ status: "BOOTSTRAP_REQUIRED" }))
			.mockResolvedValueOnce(Response.json({ user: { id: "guest" } }))
			.mockResolvedValueOnce(Response.json({ status: "READY" }));
		await prepareInlineGuestTrial(handoff, fetcher);
		expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
			"/draft/continue",
			"/api/auth/sign-in/anonymous",
			"/draft/continue",
		]);
		const body = fetcher.mock.calls[0]![1]?.body;
		expect(body).toBeInstanceOf(URLSearchParams);
		expect((body as URLSearchParams).get("claimToken")).toBe(handoff.claimToken);
		expect(fetcher.mock.calls.every(([, options]) => options?.redirect === "error")).toBe(true);
	});

	it("reuses an existing anonymous session without creating another", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ status: "SESSION_READY" }))
			.mockResolvedValueOnce(Response.json({ status: "READY" }));
		await prepareInlineGuestTrial(handoff, fetcher);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(fetcher.mock.calls.every(([path]) => path === "/draft/continue")).toBe(true);
	});

	it("stops on uncertain bootstrap failure without replay or generation", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ status: "BOOTSTRAP_REQUIRED" }))
			.mockRejectedValueOnce(new Error("network timeout"));
		await expect(prepareInlineGuestTrial(handoff, fetcher)).rejects.toThrow("network timeout");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("leaves paid and changed-account requests to the account flow", async () => {
		const fetcher = vi.fn<typeof fetch>();
		await expect(
			prepareInlineGuestTrial({ ...handoff, accessHint: "paid-account" }, fetcher),
		).rejects.toThrow("ACCOUNT_HANDOFF_REQUIRED");
		expect(fetcher).not.toHaveBeenCalled();
		fetcher.mockResolvedValueOnce(
			Response.json({ code: "ACCOUNT_HANDOFF_REQUIRED" }, { status: 409 }),
		);
		await expect(prepareInlineGuestTrial(handoff, fetcher)).rejects.toThrow(
			"ACCOUNT_HANDOFF_REQUIRED",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
