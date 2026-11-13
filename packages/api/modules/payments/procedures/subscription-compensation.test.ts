import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	claim: vi.fn(),
	get: vi.fn(),
	dismiss: vi.fn(),
	limit: vi.fn(),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database", () => ({
	claimSubscriptionCompensationOffer: mocks.claim,
	getSubscriptionCompensationOffer: mocks.get,
	dismissSubscriptionCompensationOffer: mocks.dismiss,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("../../media/lib/rate-limit", () => ({ enforceMediaRateLimit: mocks.limit }));
import {
	claimSubscriptionCompensation,
	dismissSubscriptionCompensation,
	getSubscriptionCompensation,
} from "./subscription-compensation";

const assetId = "83b43d39-b1be-4fd2-9a2d-56e701716bc5";
beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue({ user: { id: "owner-a" }, session: {} });
	mocks.claim.mockResolvedValue(null);
	mocks.get.mockResolvedValue(null);
});
describe("private subscription compensation API", () => {
	it("binds claim, read and dismissal to the current user", async () => {
		const context = { headers: new Headers() };
		expect(await call(claimSubscriptionCompensation, { assetId }, { context })).toEqual({
			offer: null,
		});
		expect(mocks.claim).toHaveBeenCalledWith({ assetId, ownerId: "owner-a" }, {});
		await call(getSubscriptionCompensation, {}, { context });
		expect(mocks.get).toHaveBeenCalledWith("owner-a", {});
		await call(dismissSubscriptionCompensation, {}, { context });
		expect(mocks.dismiss).toHaveBeenCalledWith("owner-a", {});
	});
	it.each([null, { user: { id: "guest", isAnonymous: true }, session: {} }])(
		"rejects unauthenticated/anonymous users",
		async (session) => {
			mocks.session.mockResolvedValue(session);
			await expect(
				call(claimSubscriptionCompensation, { assetId }, { context: { headers: new Headers() } }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.claim).not.toHaveBeenCalled();
		},
	);
	it("rejects injected ownership, rates, and fabricated error evidence", async () => {
		await expect(
			call(
				claimSubscriptionCompensation,
				{ assetId, ownerId: "other", bonusPercent: 100, error: "RATE_LIMITED" } as never,
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.claim).not.toHaveBeenCalled();
	});
});
