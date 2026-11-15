import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: vi.fn() }));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
import { dispatchJob } from "@repo/jobs/orchestration/client";

import { dispatchCommittedTask } from "./dispatch-committed-task";

beforeEach(() => vi.clearAllMocks());
it("hands dispatch acceptance to the managed lifetime without waiting for the task", async () => {
	let finish!: () => void;
	vi.mocked(dispatchJob).mockReturnValue(
		new Promise((resolve) => {
			finish = () => resolve({} as never);
		}),
	);
	const defer = vi.fn();
	await dispatchCommittedTask(
		"media-admit-guest-generation",
		{ jobId: "j", trialId: "t" },
		"trial:t",
		defer,
	);
	expect(defer).toHaveBeenCalledOnce();
	expect(dispatchJob).toHaveBeenCalledOnce();
	finish();
	await defer.mock.calls[0]![0];
});
it("drains the same wake when lifetime registration throws; uncertain acceptance never resubmits", async () => {
	vi.mocked(dispatchJob).mockRejectedValue(new Error("WORKFLOWS_DISPATCH_UNCONFIRMED"));
	await expect(
		dispatchCommittedTask(
			"media-process-payment-event",
			{ paymentEventId: "p" },
			"payment:p",
			() => {
				throw new Error("closed");
			},
		),
	).resolves.toBeUndefined();
	expect(dispatchJob).toHaveBeenCalledOnce();
});
