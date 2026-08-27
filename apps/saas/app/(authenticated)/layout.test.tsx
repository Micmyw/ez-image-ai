import { beforeEach, describe, expect, it, vi } from "vitest";

const authServer = vi.hoisted(() => ({
	getSession: vi.fn(),
	getOrganizationList: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock("@auth/components/SessionProvider", () => ({ SessionProvider: vi.fn() }));
vi.mock("@auth/lib/api", () => ({ sessionQueryKey: ["session"] }));
vi.mock("@auth/lib/server", () => authServer);
vi.mock("@organizations/components/ActiveOrganizationProvider", () => ({
	ActiveOrganizationProvider: vi.fn(),
}));
vi.mock("@organizations/lib/api", () => ({ organizationListQueryKey: ["organizations"] }));
vi.mock("@payments/lib/server", () => ({ listPurchases: vi.fn() }));
vi.mock("@repo/auth/config", () => ({ config: { organizations: { enable: true } } }));
vi.mock("@repo/payments/config", () => ({ config: { billingAttachedTo: "user" } }));
vi.mock("@shared/components/ConfirmationAlertProvider", () => ({
	ConfirmationAlertProvider: vi.fn(),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { payments: { listPurchases: { queryKey: vi.fn(() => ["purchases"]) } } },
}));
vi.mock("@shared/lib/server", () => ({
	getServerQueryClient: vi.fn(() => ({ prefetchQuery: vi.fn() })),
}));
vi.mock("@tanstack/react-query", () => ({
	dehydrate: vi.fn(),
	HydrationBoundary: vi.fn(),
}));
vi.mock("next/navigation", () => navigation);

import AuthenticatedLayout from "./layout";

describe("authenticated layout anonymous boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		navigation.redirect.mockImplementation((destination: string) => {
			throw new Error(`REDIRECT:${destination}`);
		});
	});

	it("redirects an anonymous Better Auth session to the guest trial surface", async () => {
		authServer.getSession.mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session", userId: "guest" },
		});

		await expect(AuthenticatedLayout({ children: null })).rejects.toThrow("REDIRECT:/try");
		expect(navigation.redirect).toHaveBeenCalledWith("/try");
	});
});
