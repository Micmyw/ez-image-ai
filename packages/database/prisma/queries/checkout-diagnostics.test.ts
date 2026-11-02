import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({ db: {} }));
import { listCheckoutDiagnostics, recordCheckoutDiagnostic } from "./checkout-diagnostics";

describe("checkout diagnostic persistence", () => {
	beforeEach(() => vi.clearAllMocks());
	it("deduplicates browser receipts per order without rewriting the first receipt", async () => {
		const upsert = vi.fn().mockResolvedValue({});
		const client = { auditLog: { upsert } } as never;
		const input = {
			intentId: "checkout-1",
			actorUserId: "user-1",
			diagnostic: {
				version: 1 as const,
				source: "browser" as const,
				event: "redirect_requested" as const,
			},
		};
		await recordCheckoutDiagnostic(input, client);
		await recordCheckoutDiagnostic(input, client);
		await recordCheckoutDiagnostic({ ...input, intentId: "checkout-2" }, client);
		expect(upsert.mock.calls[0][0].where.id).toBe(upsert.mock.calls[1][0].where.id);
		expect(upsert.mock.calls[0][0].where.id).not.toBe(upsert.mock.calls[2][0].where.id);
		expect(upsert.mock.calls[1][0].update).toEqual({});
		expect(upsert.mock.calls[0][0].create).toMatchObject({
			targetId: "checkout-1",
			action: "PAYMENT_CHECKOUT_DIAGNOSTIC",
			metadata: input.diagnostic,
		});
	});
	it("bounds recent orders and timelines and exposes omitted evidence", async () => {
		const findMany = vi
			.fn()
			.mockResolvedValue(Array.from({ length: 21 }, (_, i) => ({ id: `checkout-${i}` })));
		const logs = vi.fn().mockResolvedValue(
			Array.from({ length: 101 }, (_, i) => ({
				id: `event-${i}`,
				createdAt: new Date("2026-11-02"),
				metadata:
					i === 0
						? { raw: "should not escape" }
						: { version: 1, source: "browser", event: "return_unmarked" },
			})),
		);
		const result = await listCheckoutDiagnostics({ since: new Date("2026-11-01"), limit: 1000 }, {
			paymentCheckoutIntent: { findMany },
			auditLog: { findMany: logs },
		} as never);
		expect(findMany.mock.calls[0][0].take).toBe(21);
		expect(result.rows).toHaveLength(20);
		expect(result.truncated).toBe(true);
		expect(result.rows[0]).toMatchObject({ eventsTruncated: true, unreadableEvents: 1 });
		expect(result.rows[0].events).toHaveLength(99);
		expect(logs.mock.calls[0][0].where).toEqual({
			action: "PAYMENT_CHECKOUT_DIAGNOSTIC",
			targetType: "PAYMENT_CHECKOUT_INTENT",
			targetId: "checkout-0",
		});
		expect(JSON.stringify(result)).not.toContain("should not escape");
	});
});
