import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	claimAdminBotReceipt: vi.fn(),
	completeAdminBotReceipt: vi.fn(),
	getPaymentBotData: vi.fn(),
	getSupportBotIdentity: vi.fn(),
}));
vi.mock("./configuration", () => ({
	readBotConfiguration: vi.fn(),
	mergeBotConfiguration: vi.fn(),
}));
vi.mock("./channels", () => ({ sendBotChannels: vi.fn() }));

import { claimAdminBotReceipt, completeAdminBotReceipt, getPaymentBotData } from "@repo/database";

import { sendBotChannels } from "./channels";
import { readBotConfiguration } from "./configuration";
import { notifyAdminPaymentSuccess, renderBotTemplate } from "./service";
import { DEFAULT_BOT_CONFIGURATION } from "./types";

const reference = {
	paymentEventId: "event",
	provider: "paypal",
	kind: "subscription" as const,
	providerPaymentId: "payment",
	providerSubscriptionId: "sub",
};
describe("committed business notification receipts", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(readBotConfiguration).mockResolvedValue({
			version: 1,
			configuration: { ...structuredClone(DEFAULT_BOT_CONFIGURATION), paymentEnabled: true },
		});
		vi.mocked(getPaymentBotData).mockResolvedValue({
			eventKey: "payment:paypal:live:payment",
			provider: "paypal",
			orderId: "order",
			providerPaymentId: "payment",
			amountMicros: "99000000",
			currency: "USD",
			paidAt: "2026-10-20T00:00:00.000Z",
			chargeType: "renewal",
			plan: "Pro",
			user: null,
			attribution: null,
		});
		vi.mocked(claimAdminBotReceipt).mockResolvedValue(true);
		vi.mocked(sendBotChannels).mockResolvedValue([{ channel: "webhook", success: true }]);
	});
	it("claims the immutable payment key and suppresses duplicate business events", async () => {
		vi.mocked(claimAdminBotReceipt).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await notifyAdminPaymentSuccess(reference);
		await notifyAdminPaymentSuccess({
			...reference,
			paymentEventId: "another-webhook-same-payment",
		});
		expect(sendBotChannels).toHaveBeenCalledOnce();
		expect(sendBotChannels).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				event: "payment.succeeded",
				test: false,
				data: expect.objectContaining({ amount_micros: "99000000", payment_type: "renewal" }),
			}),
		);
		expect(completeAdminBotReceipt).toHaveBeenCalledOnce();
	});
	it("does not send unverified money and does not fail completed payment on notification storage failure", async () => {
		vi.mocked(getPaymentBotData).mockResolvedValueOnce(null);
		await notifyAdminPaymentSuccess(reference);
		expect(claimAdminBotReceipt).not.toHaveBeenCalled();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(claimAdminBotReceipt).mockRejectedValueOnce(new Error("database password private"));
		await expect(notifyAdminPaymentSuccess(reference)).resolves.toBeUndefined();
		expect(sendBotChannels).not.toHaveBeenCalled();
		expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
		warning.mockRestore();
	});
	it("substitutes template variables once and bounds chat output", () => {
		expect(renderBotTemplate("{{user}} {{amount}}", { user: "{{amount}}", amount: "USD 10" })).toBe(
			"{{amount}} USD 10",
		);
		expect(renderBotTemplate("{{content}}", { content: "x".repeat(10_000) })).toHaveLength(4000);
	});
});
