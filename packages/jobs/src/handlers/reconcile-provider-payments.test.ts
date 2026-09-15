import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
	configured: vi.fn(),
	read: vi.fn(),
	reconcile: vi.fn(),
	schedule: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/payments", () => ({
	isPaymentProviderConfigured: state.configured,
	getPaymentProvider: () => ({ listPaymentEvents: state.read }),
	paymentReconciliationScope: () => "paypal:scope",
	reconcileProviderPaymentEvents: state.reconcile,
}));
import { reconcileProviderPayments } from "./reconcile-provider-payments";
describe("provider payment continuation", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		state.configured.mockReturnValue(true);
		state.schedule.mockResolvedValue(undefined);
	});
	it("continues from the persisted cursor without waiting for the next hourly sweep", async () => {
		state.reconcile.mockResolvedValue({
			skipped: false,
			completed: false,
			recovered: 100,
			continuationKey: "window:page-3",
		});
		await reconcileProviderPayments({ provider: "paypal", scheduleNext: state.schedule });
		expect(state.schedule).toHaveBeenCalledExactlyOnceWith("paypal", "window:page-3");
	});
	it.each([
		{ skipped: false, completed: true },
		{ skipped: true, completed: false },
	])("does not schedule more work for completed or already leased sweeps: %s", async (result) => {
		state.reconcile.mockResolvedValue({ ...result, recovered: 0 });
		await reconcileProviderPayments({ provider: "waffo", scheduleNext: state.schedule });
		expect(state.schedule).not.toHaveBeenCalled();
	});
	it("retries the current task if continuation dispatch cannot be confirmed", async () => {
		state.reconcile.mockResolvedValue({
			skipped: false,
			completed: false,
			recovered: 100,
			continuationKey: "window:page-3",
		});
		state.schedule.mockRejectedValue(new Error("DISPATCH_UNAVAILABLE"));
		await expect(
			reconcileProviderPayments({ provider: "paypal", scheduleNext: state.schedule }),
		).rejects.toThrow("DISPATCH_UNAVAILABLE");
	});
	it("does not query a channel that has been disabled since scheduling", async () => {
		state.configured.mockReturnValue(false);
		await reconcileProviderPayments({ provider: "paypal", scheduleNext: state.schedule });
		expect(state.reconcile).not.toHaveBeenCalled();
	});
});
