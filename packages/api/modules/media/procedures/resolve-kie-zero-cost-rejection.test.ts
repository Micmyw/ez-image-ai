import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({ resolveAdminKieZeroCostRejection: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { auth } from "@repo/auth";
import { resolveAdminKieZeroCostRejection } from "@repo/database";

import { resolveKieZeroCostRejection } from "./resolve-kie-zero-cost-rejection";

const context = { context: { headers: new Headers() } };
const input = {
	attemptId: "attempt-1",
	idempotencyKey: "repair-unique-key",
	reason: "Verified provider dashboard terminal evidence",
	providerEvidenceReference: "Kie authenticated dashboard task record",
	evidence: {
		version: 1,
		provider: "kie",
		source: "dashboard-log",
		taskId: "task-1",
		model: "nano-banana-2-lite",
		state: "fail",
		failCode: "400",
		failMsg:
			"The input or output was flagged as sensitive. Please try again with different inputs.",
		consumptionField: "consumeCredits",
		consumedCredits: 0,
		outputCount: 0,
		observedAt: new Date().toISOString(),
	},
} as const;

describe("audited zero-cost rejection recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "admin-1", role: "admin" },
			session: { id: "session-1" },
		} as never);
	});
	it.each([null, { user: { id: "user-1", role: "user" }, session: { id: "session-1" } }])(
		"rejects unauthenticated or non-admin recovery",
		async (session) => {
			vi.mocked(auth.api.getSession).mockResolvedValue(session as never);
			await expect(call(resolveKieZeroCostRejection, input, context)).rejects.toMatchObject({
				code: session ? "FORBIDDEN" : "UNAUTHORIZED",
			});
			expect(resolveAdminKieZeroCostRejection).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ consumedCredits: 5 },
		{ outputCount: 1 },
		{ failMsg: "Unknown failure" },
		{ source: "record-info" },
		{ model: undefined },
	])("rejects incomplete or nonzero evidence: %j", async (overrides) => {
		await expect(
			call(
				resolveKieZeroCostRejection,
				{ ...input, evidence: { ...input.evidence, ...overrides } } as never,
				context,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(resolveAdminKieZeroCostRejection).not.toHaveBeenCalled();
	});
	it("binds the real administrator identity and returns the committed settlement intent", async () => {
		const result = {
			attemptId: "attempt-1",
			jobId: "job-1",
			reservedCredits: "5",
			settlementEventId: "event-1",
			replayed: false,
		};
		vi.mocked(resolveAdminKieZeroCostRejection).mockResolvedValue(result);
		expect(await call(resolveKieZeroCostRejection, input, context)).toEqual(result);
		expect(resolveAdminKieZeroCostRejection).toHaveBeenCalledWith(
			{ ...input, actorUserId: "admin-1" },
			expect.anything(),
		);
	});
	it("returns an explicit conflict when task or accounting evidence changed", async () => {
		vi.mocked(resolveAdminKieZeroCostRejection).mockRejectedValue(
			new Error("KIE_REJECTION_EVIDENCE_CONFLICT"),
		);
		await expect(call(resolveKieZeroCostRejection, input, context)).rejects.toMatchObject({
			code: "CONFLICT",
			message: "KIE_REJECTION_EVIDENCE_CONFLICT",
		});
	});
});
