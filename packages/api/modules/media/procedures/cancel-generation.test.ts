import { call, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const tx = {
		generationJob: { findFirst: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
		outboxEvent: { upsert: vi.fn() },
	};
	return {
		getSession: vi.fn(),
		tx,
		database: { $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) },
	};
});

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database/client", () => ({ db: mocks.database }));

import { cancelGeneration } from "./cancel-generation";

const context = { context: { headers: new Headers() } };

function job(status: string, uncertainAttempts = 0) {
	return {
		id: "job-1",
		status,
		version: 4,
		attempts: Array.from({ length: uncertainAttempts }, (_, index) => ({ id: `a-${index}` })),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({
		user: { id: "user-1", isAnonymous: false },
		session: { id: "session-1" },
	});
	mocks.tx.generationJob.updateMany.mockResolvedValue({ count: 1 });
});

describe("cancelGeneration after provider submission", () => {
	it.each(["PROVIDER_PENDING", "PROVIDER_RUNNING"])(
		"requests provider cancellation for a confirmed %s submission",
		async (status) => {
			mocks.tx.generationJob.findFirst.mockResolvedValueOnce(job(status));
			mocks.tx.generationJob.findUniqueOrThrow.mockResolvedValueOnce({
				id: "job-1",
				status,
				version: 5,
			});
			await expect(call(cancelGeneration, { jobId: "job-1" }, context)).resolves.toEqual({
				id: "job-1",
				status,
			});
			expect(mocks.tx.generationJob.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						status: { in: ["PROVIDER_PENDING", "PROVIDER_RUNNING"] },
					}),
					data: { version: { increment: 1 } },
				}),
			);
			expect(mocks.tx.outboxEvent.upsert).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { dedupeKey: "generation-cancel:job-1" },
					create: expect.objectContaining({ eventType: "GENERATION_CANCEL_REQUESTED" }),
				}),
			);
		},
	);

	it("cancels and settles immediately before submission", async () => {
		mocks.tx.generationJob.findFirst.mockResolvedValueOnce(job("DISPATCH_QUEUED"));
		mocks.tx.generationJob.findUniqueOrThrow.mockResolvedValueOnce({
			id: "job-1",
			status: "CANCELED",
			version: 5,
		});
		await call(cancelGeneration, { jobId: "job-1" }, context);
		expect(mocks.tx.outboxEvent.upsert).toHaveBeenCalledWith(
			expect.objectContaining({ where: { dedupeKey: "generation-settle:job-1" } }),
		);
	});

	it("refuses only uncertain submissions, which need reconciliation first", async () => {
		mocks.tx.generationJob.findFirst.mockResolvedValueOnce(job("PROVIDER_PENDING", 1));
		await expect(call(cancelGeneration, { jobId: "job-1" }, context)).rejects.toBeInstanceOf(
			ORPCError,
		);
		expect(mocks.tx.generationJob.updateMany).not.toHaveBeenCalled();
	});

	it("refuses SUBMITTING, where the provider request may be in flight", async () => {
		mocks.tx.generationJob.findFirst.mockResolvedValueOnce(job("SUBMITTING"));
		await expect(call(cancelGeneration, { jobId: "job-1" }, context)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("only reads uncertain attempts, so confirmed attempts never block cancellation", async () => {
		mocks.tx.generationJob.findFirst.mockResolvedValueOnce(job("PROVIDER_RUNNING"));
		mocks.tx.generationJob.findUniqueOrThrow.mockResolvedValueOnce({
			id: "job-1",
			status: "PROVIDER_RUNNING",
			version: 5,
		});
		await call(cancelGeneration, { jobId: "job-1" }, context);
		const query = mocks.tx.generationJob.findFirst.mock.calls[0]![0] as {
			select: { attempts: { where: unknown } };
		};
		expect(query.select.attempts.where).toEqual({
			OR: [
				{ uncertainSubmission: true },
				{ status: { in: ["SUBMISSION_UNCERTAIN", "NEEDS_RECONCILIATION"] } },
			],
		});
	});
});
