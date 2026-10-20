import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	claimPaymentEvent: vi.fn(),
	failPaymentEvent: vi.fn(),
	runSerializable: vi.fn(),
	PAYMENT_PROVIDER_CORRELATION_MISSING: "PAYMENT_PROVIDER_CORRELATION_MISSING",
	getImagePassPurchaseByProviderPayment: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/notifications/admin-bots", () => ({ notifyAdminPaymentSuccess: vi.fn() }));
vi.mock("./credit-pack-reducer", () => ({
	applyCreditPackPaymentFact: vi.fn(),
	applyCreditPackRefundFact: vi.fn(),
}));
vi.mock("./image-pass-reducer", () => ({
	applyImagePassPaymentFact: vi.fn(),
	tryApplyImagePassAdjustment: vi.fn(),
	lockImagePassPayment: vi.fn(),
	requeueImagePassAdjustments: vi.fn(),
}));
vi.mock("./lifecycle-normalization", () => ({ normalizeProviderPaymentEvent: vi.fn() }));
vi.mock("./lifecycle-reducer", () => ({ applyProviderBillingFact: vi.fn() }));
vi.mock("./refund-reducer", () => ({ applyProviderRefundFact: vi.fn() }));
vi.mock("./stripe/event-normalizer", () => ({ normalizeStripePaymentEvent: vi.fn() }));
vi.mock("./stripe/reducer", () => ({ applyStripeBillingFact: vi.fn() }));

import { failPaymentEvent, runSerializable } from "@repo/database";
import { notifyAdminPaymentSuccess } from "@repo/notifications/admin-bots";

import { applyCreditPackPaymentFact } from "./credit-pack-reducer";
import { normalizeProviderPaymentEvent } from "./lifecycle-normalization";
import { applyProviderBillingFact } from "./lifecycle-reducer";
import { processClaimedProviderPaymentEvent } from "./processor";
import { normalizeStripePaymentEvent } from "./stripe/event-normalizer";
import { processClaimedStripePaymentEvent } from "./stripe/processor";
import { applyStripeBillingFact } from "./stripe/reducer";

const now = new Date("2026-10-20T00:00:00Z");
function fixture(provider = "waffo") {
	const state = { committed: false, status: "PROCESSING" };
	const event = () => ({
		id: "event",
		provider,
		providerEnvironment: "test",
		status: state.status,
		processingToken: "claim",
		processingLeasedUntil: new Date(now.getTime() + 60_000),
		attemptCount: 0,
		envelope: {},
	});
	const client = {
		billingPeriod: {
			findFirst: vi
				.fn()
				.mockResolvedValueOnce(null)
				.mockResolvedValue({ id: "new-payment-binding" }),
		},
		paymentEvent: {
			findUnique: vi.fn(async () => event()),
			updateMany: vi.fn(async () => {
				state.status = "PROCESSED";
				return { count: 1 };
			}),
		},
		$queryRaw: vi.fn(async () => [event()]),
	};
	vi.mocked(runSerializable).mockImplementation(async (_db, operation) => {
		const result = await operation(client as never);
		state.committed = true;
		return result;
	});
	vi.mocked(notifyAdminPaymentSuccess).mockImplementation(async () => {
		expect(state.committed).toBe(true);
	});
	return { client: client as never, state };
}
describe("payment bot hooks stay after the winning commit", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(applyCreditPackPaymentFact).mockResolvedValue({ grantsCreated: 1 });
		vi.mocked(applyProviderBillingFact).mockResolvedValue({ grantsCreated: 1 });
		vi.mocked(applyStripeBillingFact).mockResolvedValue({ grantsCreated: 1 });
		vi.mocked(failPaymentEvent).mockResolvedValue(true);
	});
	it.each(["one-time", "subscription"] as const)(
		"notifies %s only after commit and skips replay",
		async (kind) => {
			vi.mocked(normalizeProviderPaymentEvent).mockReturnValue(
				kind === "one-time"
					? ({
							kind: "CREDIT_PACK_PAID",
							fact: { provider: "waffo", providerPaymentId: "payment" },
						} as never)
					: ({
							kind: "SUBSCRIPTION",
							fact: {
								provider: "waffo",
								providerSubscriptionId: "subscription",
								payment: { providerPaymentId: "payment" },
							},
						} as never),
			);
			const { client } = fixture();
			const input = { paymentEventId: "event", processingToken: "claim", now };
			expect((await processClaimedProviderPaymentEvent(input, client)).outcome).toBe("PROCESSED");
			expect((await processClaimedProviderPaymentEvent(input, client)).outcome).toBe("SKIPPED");
			expect(notifyAdminPaymentSuccess).toHaveBeenCalledOnce();
			expect(notifyAdminPaymentSuccess).toHaveBeenCalledWith(
				expect.objectContaining({ kind, providerPaymentId: "payment" }),
			);
		},
	);
	it("does not send after rollback or an already settled payment", async () => {
		vi.mocked(normalizeProviderPaymentEvent).mockReturnValue({
			kind: "CREDIT_PACK_PAID",
			fact: { provider: "waffo", providerPaymentId: "payment" },
		} as never);
		const { client } = fixture();
		vi.mocked(runSerializable).mockRejectedValueOnce(new Error("PAYMENT_PROVIDER_TEST_ROLLBACK"));
		await processClaimedProviderPaymentEvent(
			{ paymentEventId: "event", processingToken: "claim", now },
			client,
		);
		expect(notifyAdminPaymentSuccess).not.toHaveBeenCalled();
		vi.mocked(applyCreditPackPaymentFact).mockResolvedValue({ grantsCreated: 0 });
		await processClaimedProviderPaymentEvent(
			{ paymentEventId: "event", processingToken: "claim", now },
			client,
		);
		expect(notifyAdminPaymentSuccess).not.toHaveBeenCalled();
	});
	it("includes Stripe paid invoice renewals and isolates notification failure", async () => {
		vi.mocked(normalizeStripePaymentEvent).mockResolvedValue({
			fact: {
				kind: "PAID_INVOICE",
				billingReason: "SUBSCRIPTION_CYCLE",
				providerInvoicePaymentId: "ip_1",
				providerSubscriptionId: "sub_1",
			},
		} as never);
		const { client } = fixture("stripe");
		vi.mocked(notifyAdminPaymentSuccess).mockRejectedValue(
			new Error("simulated transport failure"),
		);
		expect(
			(
				await processClaimedStripePaymentEvent(
					{ paymentEventId: "event", processingToken: "claim", now },
					client,
				)
			).outcome,
		).toBe("PROCESSED");
		expect(notifyAdminPaymentSuccess).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "stripe", kind: "subscription" }),
		);
		expect(failPaymentEvent).not.toHaveBeenCalled();
	});
	it("notifies a newly paid future subscription period before its credit grant is due", async () => {
		vi.mocked(normalizeProviderPaymentEvent).mockReturnValue({
			kind: "SUBSCRIPTION",
			fact: {
				provider: "waffo",
				providerSubscriptionId: "subscription",
				payment: { providerPaymentId: "prepaid" },
			},
		} as never);
		const { client } = fixture();
		vi.mocked(applyProviderBillingFact).mockResolvedValue({ grantsCreated: 0 });
		const result = await processClaimedProviderPaymentEvent(
			{ paymentEventId: "event", processingToken: "claim", now },
			client,
		);
		expect(result).toEqual({ outcome: "PROCESSED", grantsCreated: 0 });
		expect(notifyAdminPaymentSuccess).toHaveBeenCalledOnce();
	});
});
