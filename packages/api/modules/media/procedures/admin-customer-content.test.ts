import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), customers: vi.fn(), content: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database", () => ({
	listAdminContentCustomers: mocks.customers,
	listAdminCustomerContent: mocks.content,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
import { adminContentCustomers, adminCustomerContent } from "./admin-customer-content";

const context = () => ({ context: { headers: new Headers(), responseHeaders: new Headers() } });
const owner = { ownerType: "USER" as const, ownerId: "customer" };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.session.mockResolvedValue({
		user: { id: "admin", role: "admin", isAnonymous: false },
		session: {},
	});
	mocks.customers.mockResolvedValue({ items: [], nextCursor: null });
	mocks.content.mockResolvedValue({ items: [], nextCursor: null });
});
describe("unified administrator customer content API", () => {
	it.each([null, "user", "anonymous"])("denies %s before private reads", async (role) => {
		mocks.session.mockResolvedValue(
			role ? { user: { id: "user", role, isAnonymous: role === "anonymous" }, session: {} } : null,
		);
		await expect(call(adminContentCustomers, {}, context())).rejects.toBeDefined();
		await expect(call(adminCustomerContent, { owner }, context())).rejects.toBeDefined();
		expect(mocks.customers).not.toHaveBeenCalled();
		expect(mocks.content).not.toHaveBeenCalled();
	});
	it("requires an exact typed owner and derives the auditing administrator", async () => {
		const options = context();
		await call(adminCustomerContent, { owner }, options);
		expect(mocks.content).toHaveBeenCalledWith({ owner, limit: 25 }, "admin", expect.anything());
		expect(options.context.responseHeaders.get("Cache-Control")).toBe("private, no-store");
		expect(options.context.responseHeaders.get("X-Robots-Tag")).toBe("noindex, nofollow");
		for (const input of [
			{},
			{ owner: { ownerId: "customer" } },
			{ owner, limit: 51 },
			{ owner, actorUserId: "spoof" },
		])
			await expect(call(adminCustomerContent, input as never, context())).rejects.toBeDefined();
	});
	it("accepts customer searches in a POST body without leaking filters into URLs", async () => {
		const headers = new Headers({ "content-type": "application/json" });
		const options = context();
		const result = await new OpenAPIHandler({ customers: adminContentCustomers }).handle(
			new Request("https://example.test/api/admin/media/customers/search", {
				method: "POST",
				headers,
				body: JSON.stringify({ search: "customer@example.test" }),
			}),
			{ prefix: "/api", context: options.context },
		);
		expect(result.response?.status).toBe(200);
		expect(mocks.customers).toHaveBeenCalledWith(
			{ search: "customer@example.test", limit: 25 },
			"admin",
			expect.anything(),
		);
	});
});
