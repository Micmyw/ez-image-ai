import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
	user: { update: vi.fn() },
	purchase: { update: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("../client", () => ({ db: mockDb }));

import { updatePurchase } from "./purchases";
import { updateUser } from "./users";

describe("attribution write protection in generic edits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.user.update.mockResolvedValue({ id: "user-1" });
		mockDb.purchase.update.mockResolvedValue({ id: "purchase-1" });
		mockDb.purchase.findUnique.mockResolvedValue({ id: "purchase-1" });
	});

	it("allows a profile edit while dropping a supplied registration overwrite", async () => {
		await updateUser({
			id: "user-1",
			name: "Updated Name",
			registrationAttribution: { landingPath: "/pricing" },
		});
		expect(mockDb.user.update).toHaveBeenCalledExactlyOnceWith({
			where: { id: "user-1" },
			data: { id: "user-1", name: "Updated Name" },
		});
	});

	it("allows order status updates while dropping a supplied source overwrite", async () => {
		await updatePurchase({
			id: "purchase-1",
			status: "refunded",
			attribution: { triggerPath: "/pricing" },
		});
		expect(mockDb.purchase.update).toHaveBeenCalledExactlyOnceWith({
			where: { id: "purchase-1" },
			data: { id: "purchase-1", status: "refunded" },
		});
	});
});
