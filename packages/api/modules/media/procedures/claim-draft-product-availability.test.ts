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
});
