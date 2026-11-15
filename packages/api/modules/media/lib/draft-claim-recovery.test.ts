import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
import { getDraftClaimFailure, withDraftClaimRecovery } from "./draft-claim-recovery";

describe("draft claim failure boundary", () => {
	it("finds the actual safe code through wrapped exceptions", () => {
		expect(
			getDraftClaimFailure(
				new Error("Internal server error", {
					cause: Object.assign(new Error("SQL and private asset details"), { code: "P2010" }),
				}),
			),
		).toEqual({ recoverable: true, code: "P2010" });
		expect(
			getDraftClaimFailure(
				new Error("Internal server error", { cause: new Error("DRAFT_UNAVAILABLE") }),
			),
		).toEqual({ recoverable: false, code: "DRAFT_UNAVAILABLE" });
	});
	it("keeps unknown outcomes and correctable quota failures recoverable without exposing details", () => {
		expect(getDraftClaimFailure(new Error("private-provider-url"))).toEqual({
			recoverable: true,
			code: "UNKNOWN",
		});
		expect(getDraftClaimFailure(new Error("STORAGE_QUOTA_EXCEEDED"))).toEqual({
			recoverable: true,
			code: "STORAGE_QUOTA_EXCEEDED",
		});
		const circular: { cause?: unknown } = {};
		circular.cause = circular;
		expect(getDraftClaimFailure(circular)).toEqual({ recoverable: true, code: "UNKNOWN" });
	});
	it.each(["", "media_draft_claim=%E0%A4%A", "media_draft_claim=invalid"])(
		"rejects malformed credentials before database access: %s",
		async (cookie) => {
			const claim = vi.fn();
			const responseHeaders = new Headers();
			await expect(
				withDraftClaimRecovery(
					{ headers: new Headers({ cookie }), responseHeaders, user: { id: "guest" } },
					claim,
				),
			).rejects.toThrow("DRAFT_UNAVAILABLE");
			expect(claim).not.toHaveBeenCalled();
			expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
		},
	);
});
