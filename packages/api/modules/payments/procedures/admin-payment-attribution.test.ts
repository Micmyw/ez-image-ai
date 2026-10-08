import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({ listAdminPaymentAttribution: vi.fn() }));

import { auth } from "@repo/auth";
import { listAdminPaymentAttribution } from "@repo/database";

import { listAdminPaymentAttributionProcedure as procedure } from "./admin-payment-attribution";

const at = new Date("2026-09-01T00:00:00Z");
const attribution = {
	version: 1,
	registration: {
		version: 1,
		landingPath: "/blog/photo-ideas?email=private@example.test#token",
		referrerOrigin: "https://search.example.test/results?token=private",
		source: "campaign",
		utmSource: "search",
		utmMedium: "organic",
		utmCampaign: "autumn",
		capturedAt: "2026-07-01T00:00:00.000Z",
		registeredAt: "2026-07-02T00:00:00.000Z",
	},
	triggerPath: "/photo-to-coloring-page?session=private#token",
	triggeredAt: at.toISOString(),
};
const purchase = {
	id: "order-1",
	userId: "user-1",
	organizationId: null,
	type: "SUBSCRIPTION",
	productKind: "PLAN",
	provider: "stripe",
	status: "active",
	createdAt: at,
	attribution,
	customerId: "private-provider-customer",
	registrationAttribution: { landingPath: "/latest-user-page" },
};
const checkout = {
	id: "checkout-1",
	ownerType: "USER",
	ownerId: "user-2",
	productKind: "CREDIT_PACK",
	provider: "waffo",
	planKey: "pack-500",
	interval: "one-time",
	status: "COMPLETED",
	createdAt: at,
	attribution: null,
	providerCheckoutUrl: "https://payment.example.test/private-token",
};

describe("administrator order attribution", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin-1", role: "admin" },
			session: { id: "session-1" },
		} as never);
		vi.mocked(listAdminPaymentAttribution).mockResolvedValue({
			purchases: [purchase],
			checkouts: [checkout],
		} as never);
	});
	it.each([null, "user"])(
		"rejects missing/non-admin session (%s) before any read",
		async (role) => {
			vi.mocked(auth.api.getSession).mockResolvedValue(
				role ? ({ user: { id: "user-1", role }, session: { id: "session-1" } } as never) : null,
			);
			await expect(
				call(procedure, {}, { context: { headers: new Headers() } }),
			).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
			expect(listAdminPaymentAttribution).not.toHaveBeenCalled();
		},
	);
	it("returns frozen order attribution across product kinds, sanitizes URLs and keeps old unknown values", async () => {
		const responseHeaders = new Headers();
		const result = await call(
			procedure,
			{},
			{ context: { headers: new Headers(), responseHeaders } },
		);
		expect(listAdminPaymentAttribution).toHaveBeenCalledWith({ limit: 20 });
		expect(result.purchases[0]).toMatchObject({
			ownerType: "USER",
			ownerId: "user-1",
			attribution: {
				registration: {
					landingPath: "/blog/photo-ideas",
					referrerOrigin: "https://search.example.test",
					capturedAt: "2026-07-01T00:00:00.000Z",
				},
				triggerPath: "/photo-to-coloring-page",
			},
		});
		expect(result.checkouts[0]).toMatchObject({
			productKind: "CREDIT_PACK",
			provider: "waffo",
			attribution: null,
		});
		expect(JSON.stringify(result)).not.toMatch(/private|latest-user-page|session=|email=/);
		expect(responseHeaders.get("Cache-Control")).toBe("private, no-store");
	});
	it("looks up an exact trimmed local reference without accepting another user's input", async () => {
		await call(
			procedure,
			{ reference: "  order-1  ", limit: 1 },
			{ context: { headers: new Headers() } },
		);
		expect(listAdminPaymentAttribution).toHaveBeenCalledWith({ reference: "order-1", limit: 1 });
		for (const input of [
			{ limit: 21 },
			{ limit: 0 },
			{ reference: "x".repeat(129) },
			{ userId: "other-user" },
		]) {
			await expect(
				call(procedure, input as never, { context: { headers: new Headers() } }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
	});
	it("shows malformed historical snapshots as unknown and does not substitute current profile attribution", async () => {
		vi.mocked(listAdminPaymentAttribution).mockResolvedValue({
			purchases: [{ ...purchase, attribution: { triggerPath: "/create" } }],
			checkouts: [],
		} as never);
		const result = await call(procedure, {}, { context: { headers: new Headers() } });
		expect(result.purchases[0]?.attribution).toBeNull();
		expect(JSON.stringify(result)).not.toContain("latest-user-page");
	});
});
