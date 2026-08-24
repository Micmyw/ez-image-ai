import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	applyApprovedLegacyStripeRefundRepair: vi.fn(),
	approveLegacyStripeRefundRepair: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { auth } from "@repo/auth";
import {
	applyApprovedLegacyStripeRefundRepair,
	approveLegacyStripeRefundRepair,
} from "@repo/database";

import { paymentsRouter } from "../router";

const context = { context: { headers: new Headers() } };
const approveStripeRefundRepair = Reflect.get(paymentsRouter, "approveStripeRefundRepair");
const applyStripeRefundRepair = Reflect.get(paymentsRouter, "applyStripeRefundRepair");

const approvalInput = {
	providerRefundId: "re_legacy_123",
	issueKey: "stripe:REFUND:re_legacy_123:STRIPE_LEGACY_REFUND_REPAIR_REQUIRED",
	action: "COMPENSATE_FAILED_OR_CANCELED" as const,
	expectedLastProviderChangeId: "evt_refund_failed_123",
	expectedCredits: "50",
	approvalKey: "approval-operation-123",
	reason: "Approve the exact failed Stripe refund evidence for repair.",
};

describe("Stripe refund repair administration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects non-admin actors before either repair operation reaches the database", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user_1", role: "user" },
			session: { id: "session_1" },
		} as never);

		await expect(call(approveStripeRefundRepair, approvalInput, context)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			call(
				applyStripeRefundRepair,
				{
					approvalKey: approvalInput.approvalKey,
					idempotencyKey: "apply-operation-123",
					reason: "Apply only after a different administrator approved the repair.",
				},
				context,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(approveLegacyStripeRefundRepair).not.toHaveBeenCalled();
		expect(applyApprovedLegacyStripeRefundRepair).not.toHaveBeenCalled();
	});

	it("derives the approving admin and converts the decimal credit snapshot to bigint", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_approve", role: "admin" },
			session: { id: "session_1" },
		} as never);
		vi.mocked(approveLegacyStripeRefundRepair).mockResolvedValue({
			authorityId: "authority_1",
			approvalKey: approvalInput.approvalKey,
			replayed: false,
		} as never);

		await expect(call(approveStripeRefundRepair, approvalInput, context)).resolves.toEqual({
			authorityId: "authority_1",
			approvalKey: approvalInput.approvalKey,
			replayed: false,
		});
		expect(approveLegacyStripeRefundRepair).toHaveBeenCalledWith(
			{
				...approvalInput,
				actorUserId: "admin_approve",
				expectedCredits: 50n,
			},
			expect.anything(),
		);
	});

	it("derives a separate executing admin and serializes compensated credits", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_apply", role: "admin" },
			session: { id: "session_2" },
		} as never);
		vi.mocked(applyApprovedLegacyStripeRefundRepair).mockResolvedValue({
			authorityId: "authority_1",
			approvalKey: approvalInput.approvalKey,
			action: "COMPENSATE_FAILED_OR_CANCELED",
			receiptId: "receipt_1",
			compensatedCredits: 50n,
			replayed: false,
		} as never);
		const input = {
			approvalKey: approvalInput.approvalKey,
			idempotencyKey: "apply-operation-123",
			reason: "Apply only after a different administrator approved the repair.",
		};

		await expect(call(applyStripeRefundRepair, input, context)).resolves.toEqual({
			authorityId: "authority_1",
			approvalKey: approvalInput.approvalKey,
			action: "COMPENSATE_FAILED_OR_CANCELED",
			receiptId: "receipt_1",
			compensatedCredits: "50",
			replayed: false,
		});
		expect(applyApprovedLegacyStripeRefundRepair).toHaveBeenCalledWith(
			{ ...input, actorUserId: "admin_apply" },
			expect.anything(),
		);
	});

	it("rejects non-positive or non-decimal credit snapshots before approval", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_approve", role: "admin" },
			session: { id: "session_1" },
		} as never);

		for (const expectedCredits of ["0", "-1", "1.5", "1e3"]) {
			await expect(
				call(approveStripeRefundRepair, { ...approvalInput, expectedCredits }, context),
			).rejects.toBeDefined();
		}
		expect(approveLegacyStripeRefundRepair).not.toHaveBeenCalled();
	});

	it("maps safe repair conflicts and hides unexpected database failures", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin_approve", role: "admin" },
			session: { id: "session_1" },
		} as never);
		vi.mocked(approveLegacyStripeRefundRepair)
			.mockRejectedValueOnce(new Error("STRIPE_REFUND_REPAIR_APPROVAL_STALE"))
			.mockRejectedValueOnce(new Error("STRIPE_REFUND_REPAIR_ACCOUNT_BINDING_INVALID"))
			.mockRejectedValueOnce(new Error("STRIPE_REFUND_REPAIR_CHARGE_BINDING_INVALID"))
			.mockRejectedValueOnce(new Error("database connection contained secret details"));

		await expect(call(approveStripeRefundRepair, approvalInput, context)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		await expect(call(approveStripeRefundRepair, approvalInput, context)).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "STRIPE_REFUND_REPAIR_ACCOUNT_BINDING_INVALID" },
		});
		await expect(call(approveStripeRefundRepair, approvalInput, context)).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "STRIPE_REFUND_REPAIR_CHARGE_BINDING_INVALID" },
		});
		await expect(call(approveStripeRefundRepair, approvalInput, context)).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "STRIPE_REFUND_REPAIR_FAILED",
		});
	});
});
