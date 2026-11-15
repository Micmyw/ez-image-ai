import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	loadProducts: vi.fn(),
	claimRegistered: vi.fn(),
	claimGuest: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/logs", () => ({ logger: { warn: mocks.warn } }));
vi.mock("@repo/database", () => ({
	claimGenerationDraftTransaction: mocks.claimRegistered,
	claimGuestGenerationDraftTransaction: mocks.claimGuest,
}));
vi.mock("../lib/executable-route-graph", () => ({
	getCurrentExecutableEzPicProducts: mocks.loadProducts,
}));

import { claimGenerationDraft } from "./claim-generation-draft";
import { claimGuestDraft } from "./claim-guest-draft";

const claimToken = "c".repeat(43);
const executableProductKeys = [
	"image-nano-banana-2-lite",
	"image-nano-banana",
	"image-nano-banana-2",
	"image-nano-banana-pro",
	"image-gpt-image-1-5",
	"image-gpt-image-2",
	"image-seedream-4-5",
	"image-seedream-5-lite",
	"image-seedream-5-pro",
] as const;
const context = {
	context: {
		headers: new Headers({ cookie: `media_draft_claim=${claimToken}` }),
		responseHeaders: new Headers(),
	},
};

describe("draft claim product availability", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.loadProducts.mockResolvedValue(executableProductKeys.map((key) => ({ key })));
		mocks.claimRegistered.mockImplementation(async (input) => {
			if (input.allowedProductKeys.join(",") !== executableProductKeys.join(",")) {
				throw new Error("DRAFT_PRODUCT_POLICY_MISSING");
			}
			return { id: "draft_registered", productKey: "image-gpt-image-2", input: {} };
		});
		mocks.claimGuest.mockImplementation(async (input) => {
			if (input.allowedProductKeys.join(",") !== executableProductKeys.join(",")) {
				throw new Error("DRAFT_PRODUCT_POLICY_MISSING");
			}
			return { id: "draft_guest", productKey: "image-seedream-5-pro", input: {} };
		});
	});

	it.each([true, false])(
		"retains the same claim after a failed transaction and consumes it only on successful retry (guest=%s)",
		async (guest) => {
			mocks.getSession.mockResolvedValue({
				session: { id: "session" },
				user: { id: "owner", isAnonymous: guest },
			});
			const transaction = guest ? mocks.claimGuest : mocks.claimRegistered;
			const procedure = guest ? claimGuestDraft : claimGenerationDraft;
			transaction.mockRejectedValueOnce(
				Object.assign(new Error("private database detail"), { code: "P2028" }),
			);
			const responseHeaders = new Headers();
			const options = { context: { headers: context.context.headers, responseHeaders } };
			await expect(call(procedure, undefined, options)).rejects.toThrow();
			expect(responseHeaders.getSetCookie()).toEqual([]);
			expect(mocks.warn).toHaveBeenCalledWith(
				"media.draft.claim.failed",
				expect.objectContaining({ stage: "ownership", recoverable: true, code: "P2028" }),
			);
			expect(JSON.stringify(mocks.warn.mock.calls)).not.toMatch(
				/private database detail|cccccccccc/,
			);
			await call(procedure, undefined, options);
			expect(responseHeaders.getSetCookie().join("\n")).toContain("media_draft_claim=;");
			expect(transaction.mock.calls[0]?.[0]).toEqual(transaction.mock.calls[1]?.[0]);
		},
	);

	it("retains the claim when the catalog is temporarily unavailable", async () => {
		mocks.getSession.mockResolvedValue({
			session: { id: "session" },
			user: { id: "owner", isAnonymous: true },
		});
		mocks.loadProducts.mockResolvedValueOnce([]);
		const responseHeaders = new Headers();
		await expect(
			call(claimGuestDraft, undefined, {
				context: { headers: context.context.headers, responseHeaders },
			}),
		).rejects.toThrow("DRAFT_SERVICE_UNAVAILABLE");
		expect(responseHeaders.getSetCookie()).toEqual([]);
		expect(mocks.claimGuest).not.toHaveBeenCalled();
	});

	it("clears a truly unavailable draft credential without treating it as a technical retry", async () => {
		mocks.getSession.mockResolvedValue({
			session: { id: "session" },
			user: { id: "owner", isAnonymous: true },
		});
		mocks.claimGuest.mockRejectedValueOnce(new Error("DRAFT_UNAVAILABLE"));
		const responseHeaders = new Headers();
		await expect(
			call(claimGuestDraft, undefined, {
				context: { headers: context.context.headers, responseHeaders },
			}),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(responseHeaders.getSetCookie().join("\n")).toContain("Max-Age=0");
	});

	it("allows a registered account to claim every currently executable image product", async () => {
		mocks.getSession.mockResolvedValue({
			session: { id: "session_registered" },
			user: { id: "user_registered", isAnonymous: false },
		});

		await expect(call(claimGenerationDraft, undefined, context)).resolves.toMatchObject({
			id: "draft_registered",
			productKey: "image-gpt-image-2",
		});
	});

	it("lets an anonymous guest claim any executable draft before entitlement decides upgrade", async () => {
		mocks.getSession.mockResolvedValue({
			session: { id: "session_guest" },
			user: { id: "user_guest", isAnonymous: true },
		});

		await expect(call(claimGuestDraft, undefined, context)).resolves.toMatchObject({
			id: "draft_guest",
			productKey: "image-seedream-5-pro",
		});
	});
	it("returns preparation for a registered claim while expiring the sensitive claim cookie", async () => {
		mocks.getSession.mockResolvedValue({
			session: { id: "session_registered" },
			user: { id: "user_registered", isAnonymous: false },
		});
		mocks.claimRegistered.mockResolvedValue({
			id: "draft_pending",
			productKey: "image-gpt-image-2",
			input: { kind: "image-to-image", prompt: "Keep my instruction" },
			preparation: { promotionId: "copy-1", status: "COPYING" },
		});
		const responseHeaders = new Headers();
		const result = await call(claimGenerationDraft, undefined, {
			context: { headers: context.context.headers, responseHeaders },
		});
		expect(result).toMatchObject({
			id: "draft_pending",
			input: { kind: "image-to-image", prompt: "Keep my instruction" },
			preparation: { promotionId: "copy-1", status: "COPYING" },
		});
		expect(result.input).not.toHaveProperty("sourceAssetId");
		expect(responseHeaders.get("set-cookie")).toContain("media_draft_claim=;");
		expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
	});
	it("limits registered claim preparation to its public fields and reason codes", async () => {
		mocks.getSession.mockResolvedValue({
			session: { id: "registered" },
			user: { id: "account", isAnonymous: false },
		});
		mocks.claimRegistered.mockResolvedValue({
			id: "draft",
			productKey: "image-gpt-image-2",
			input: {},
			preparation: {
				promotionId: "copy",
				status: "FAILED",
				reasonCode: "PRIVATE_STORAGE_DETAIL",
				leaseToken: "private-token",
				objectKey: "private-key",
			},
		});
		const result = await call(claimGenerationDraft, undefined, context);
		expect(result.preparation).toEqual({
			promotionId: "copy",
			status: "FAILED",
			reasonCode: "ACCOUNT_INPUT_COPY_UNAVAILABLE",
		});
	});
});
