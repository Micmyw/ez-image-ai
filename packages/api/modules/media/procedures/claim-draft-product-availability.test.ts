import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	loadProducts: vi.fn(),
	claimRegistered: vi.fn(),
	claimGuest: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
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
const context = {
	context: {
		headers: new Headers({ cookie: `media_draft_claim=${claimToken}` }),
		responseHeaders: new Headers(),
	},
};

describe("draft claim product availability", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.loadProducts.mockResolvedValue([
			{ key: "image-fast", accessHint: "guest-trial" },
			{ key: "image-quality", accessHint: "paid-account" },
		]);
		mocks.claimRegistered.mockImplementation(async (input) => {
			if (input.allowedProductKeys.join(",") !== "image-fast,image-quality") {
				throw new Error("DRAFT_PRODUCT_POLICY_MISSING");
			}
			return { id: "draft_registered", productKey: "image-quality", input: {} };
		});
		mocks.claimGuest.mockImplementation(async (input) => {
			if (input.allowedProductKeys.join(",") !== "image-fast") {
				throw new Error("DRAFT_PRODUCT_POLICY_MISSING");
			}
			return { id: "draft_guest", productKey: "image-fast", input: {} };
		});
	});

	it("allows a registered account to claim either currently executable image tier", async () => {
		mocks.getSession.mockResolvedValue({
			session: { id: "session_registered" },
			user: { id: "user_registered", isAnonymous: false },
		});

		await expect(call(claimGenerationDraft, undefined, context)).resolves.toMatchObject({
			id: "draft_registered",
			productKey: "image-quality",
		});
	});

	it("allows an anonymous guest to claim only the executable guest-trial tier", async () => {
		mocks.getSession.mockResolvedValue({
			session: { id: "session_guest" },
			user: { id: "user_guest", isAnonymous: true },
		});

		await expect(call(claimGuestDraft, undefined, context)).resolves.toMatchObject({
			id: "draft_guest",
			productKey: "image-fast",
		});
	});
});
