import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	intent: vi.fn(),
	record: vi.fn(),
	list: vi.fn(),
	membership: vi.fn(),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", async () => ({
	...(await import("../../../../database/shared/checkout-diagnostics")),
	getPaymentCheckoutIntentById: mocks.intent,
	recordCheckoutDiagnostic: mocks.record,
	listCheckoutDiagnostics: mocks.list,
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationBillingManagement: mocks.membership,
}));

import { getAdminCheckoutDiagnostics, reportCheckoutDiagnostic } from "./checkout-diagnostics";

const session = (role = "user", organization: string | null = null) => ({
	user: { id: "owner", role, isAnonymous: false },
	session: { activeOrganizationId: organization },
});
const context = () => ({
	headers: new Headers({ origin: "https://app.test" }),
	responseHeaders: new Headers(),
});
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.test");
	mocks.session.mockResolvedValue(session());
	mocks.intent.mockResolvedValue({
		id: "intent",
		ownerType: "USER",
		ownerId: "owner",
		productKind: "IMAGE_PASS",
	});
	mocks.record.mockResolvedValue(undefined);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("browser checkout diagnostic authorization", () => {
	it("accepts the actual keepalive JSON transport and derives identity/provenance", async () => {
		const handler = new OpenAPIHandler({ reportCheckoutDiagnostic });
		const ctx = context();
		const { response } = await handler.handle(
			new Request("https://app.test/api/payments/checkout-diagnostics", {
				method: "POST",
				headers: { origin: "https://app.test", "Content-Type": "application/json" },
				body: JSON.stringify({ intentId: "intent", event: "return_approved" }),
			}),
			{ prefix: "/api", context: ctx },
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ recorded: true });
		expect(mocks.record).toHaveBeenCalledWith({
			intentId: "intent",
			actorUserId: "owner",
			diagnostic: { version: 1, source: "browser", event: "return_approved" },
		});
		expect(ctx.responseHeaders.get("cache-control")).toBe("private, no-store");
	});
	it.each([null, { user: { id: "guest", isAnonymous: true }, session: {} }])(
		"rejects missing or anonymous authentication",
		async (value) => {
			mocks.session.mockResolvedValue(value);
			await expect(
				call(
					reportCheckoutDiagnostic,
					{ intentId: "intent", event: "redirect_requested" },
					{ context: context() },
				),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.record).not.toHaveBeenCalled();
		},
	);
	it("rejects another owner and a foreign origin", async () => {
		mocks.intent.mockResolvedValue({
			id: "intent",
			ownerType: "USER",
			ownerId: "other",
			productKind: "IMAGE_PASS",
		});
		await expect(
			call(
				reportCheckoutDiagnostic,
				{ intentId: "intent", event: "redirect_requested" },
				{ context: context() },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			call(
				reportCheckoutDiagnostic,
				{ intentId: "intent", event: "redirect_requested" },
				{ context: { headers: new Headers({ origin: "https://foreign.test" }) } },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.record).not.toHaveBeenCalled();
	});
	it("requires the active organization and its billing authority", async () => {
		mocks.intent.mockResolvedValue({
			id: "intent",
			ownerType: "ORGANIZATION",
			ownerId: "org",
			productKind: "CREDIT_PACK",
		});
		await expect(
			call(
				reportCheckoutDiagnostic,
				{ intentId: "intent", event: "return_unmarked" },
				{ context: context() },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		mocks.session.mockResolvedValue(session("user", "org"));
		mocks.membership.mockResolvedValue(null);
		await expect(
			call(
				reportCheckoutDiagnostic,
				{ intentId: "intent", event: "return_unmarked" },
				{ context: context() },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		mocks.membership.mockResolvedValue({ organization: { id: "org" } });
		await expect(
			call(
				reportCheckoutDiagnostic,
				{ intentId: "intent", event: "return_unmarked" },
				{ context: context() },
			),
		).resolves.toEqual({ recorded: true });
	});
	it.each([
		{ intentId: "intent", event: "capture_succeeded" },
		{ intentId: "intent", event: "return_approved", source: "server" },
		{ intentId: "intent", event: "return_unmarked", token: "provider-secret" },
	])("rejects forged server evidence and extra payload fields", async (input) => {
		await expect(
			call(reportCheckoutDiagnostic, input as never, { context: context() }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.record).not.toHaveBeenCalled();
	});
	it("reports a storage miss without pretending to have recorded evidence", async () => {
		mocks.record.mockRejectedValue(new Error("storage unavailable"));
		await expect(
			call(
				reportCheckoutDiagnostic,
				{ intentId: "intent", event: "redirect_failed" },
				{ context: context() },
			),
		).resolves.toEqual({ recorded: false });
	});
});

describe("admin checkout diagnostics", () => {
	it("denies ordinary users through the real admin middleware", async () => {
		await expect(
			call(getAdminCheckoutDiagnostics, { range: "30d", limit: 20 }, { context: context() }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it("keeps expired historical orders unknown and exposes incomplete coverage", async () => {
		mocks.session.mockResolvedValue(session("admin"));
		mocks.list.mockResolvedValue({
			truncated: false,
			rows: [
				{
					id: "old",
					ownerType: "USER",
					ownerId: "owner",
					provider: "paypal",
					productKind: "IMAGE_PASS",
					planKey: "image-pass-3",
					status: "PROVIDER_PENDING",
					createdAt: new Date("2026-10-29"),
					expiresAt: new Date("2026-10-29T03:00:00Z"),
					events: [],
					eventsTruncated: false,
					unreadableEvents: 0,
				},
			],
		});
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-02"));
		const result = await call(
			getAdminCheckoutDiagnostics,
			{ range: "30d", limit: 20 },
			{ context: context() },
		);
		expect(result.rows[0]).toMatchObject({ expired: true, outcome: "UNCONFIRMED", events: [] });
		expect(mocks.list).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 20, since: new Date("2026-10-03") }),
		);
	});
});
