import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getOrganizationList: vi.fn(),
	listPurchases: vi.fn(),
}));

vi.mock("@auth/lib/server", () => mocks);
vi.mock("@payments/lib/server", () => ({ listPurchases: mocks.listPurchases }));
vi.mock("@repo/auth/config", () => ({
	config: {
		users: { enableOnboarding: true },
		organizations: { enable: true, requireOrganization: false },
	},
}));
vi.mock("@repo/payments/config", () => ({ config: { requireActiveSubscription: false } }));
vi.mock("@repo/payments/lib/helper", () => ({ createPurchasesHelper: vi.fn() }));

import { MainAccountBoundary } from "./MainAccountBoundary";

describe("main account authentication boundary", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.getOrganizationList.mockResolvedValue([]);
	});

	it("redirects a signed-out visitor to login", async () => {
		mocks.getSession.mockResolvedValue(null);
		await expect(MainAccountBoundary({ children: null })).rejects.toMatchObject({
			digest: "NEXT_REDIRECT;replace;/login;307;",
		});
		expect(mocks.getOrganizationList).not.toHaveBeenCalled();
		expect(mocks.listPurchases).not.toHaveBeenCalled();
	});

	it("sends trial users to the same guest destination as the parallel registered layout", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: "guest", isAnonymous: true, onboardingComplete: false },
		});
		await expect(MainAccountBoundary({ children: null })).rejects.toMatchObject({
			digest: "NEXT_REDIRECT;replace;/try;307;",
		});
		expect(mocks.getOrganizationList).not.toHaveBeenCalled();
		expect(mocks.listPurchases).not.toHaveBeenCalled();
	});

	it("preserves registered-user onboarding", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: "member", isAnonymous: false, onboardingComplete: false },
		});
		await expect(MainAccountBoundary({ children: null })).rejects.toMatchObject({
			digest: "NEXT_REDIRECT;replace;/onboarding;307;",
		});
	});

	it("renders the account for an onboarded member", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: "member", isAnonymous: false, onboardingComplete: true },
		});
		await expect(MainAccountBoundary({ children: "account" })).resolves.toBe("account");
	});
});
