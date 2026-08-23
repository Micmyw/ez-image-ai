import { describe, expect, it, vi } from "vitest";

import { recoverFinalizingGenerations } from "./recover-finalizing-generations";

describe("recoverFinalizingGenerations", () => {
	it("normalizes the scan limit and passes a stable stale boundary to the store", async () => {
		const now = new Date("2026-08-24T08:00:00.000Z");
		const listCandidates = vi.fn(async () => [{ jobId: "job-1" }, { jobId: "job-2" }]);
		const recoverCandidate = vi.fn(async () => "RECOVERED" as const);

		await expect(
			recoverFinalizingGenerations(
				{ limit: 0, staleAfterSeconds: 300 },
				{ listCandidates, recoverCandidate, now: () => now },
			),
		).resolves.toEqual({ scanned: 1, recovered: 1, skipped: 0, exhausted: 0, failed: 0 });
		expect(listCandidates).toHaveBeenCalledWith({
			limit: 1,
			now,
			staleBefore: new Date("2026-08-24T07:55:00.000Z"),
		});
		expect(recoverCandidate).toHaveBeenCalledTimes(1);
		expect(recoverCandidate).toHaveBeenCalledWith(
			{ jobId: "job-1" },
			{ now, staleBefore: new Date("2026-08-24T07:55:00.000Z") },
		);
	});

	it("caps oversized limits at one hundred", async () => {
		const listCandidates = vi.fn(async () => []);

		await recoverFinalizingGenerations(
			{ limit: 10_000 },
			{
				listCandidates,
				recoverCandidate: vi.fn(),
				now: () => new Date("2026-08-24T08:00:00.000Z"),
			},
		);

		expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
	});

	it("isolates candidate failures and reports each durable outcome", async () => {
		const recoverCandidate = vi.fn(async ({ jobId }: { jobId: string }) => {
			if (jobId === "job-recovered") return "RECOVERED" as const;
			if (jobId === "job-skipped") return "SKIPPED" as const;
			if (jobId === "job-exhausted") return "EXHAUSTED" as const;
			throw new Error("candidate row is damaged");
		});

		await expect(
			recoverFinalizingGenerations(
				{ limit: 25 },
				{
					listCandidates: async () => [
						{ jobId: "job-recovered" },
						{ jobId: "job-failed" },
						{ jobId: "job-skipped" },
						{ jobId: "job-exhausted" },
					],
					recoverCandidate,
					now: () => new Date("2026-08-24T08:00:00.000Z"),
				},
			),
		).resolves.toEqual({ scanned: 4, recovered: 1, skipped: 1, exhausted: 1, failed: 1 });
		expect(recoverCandidate).toHaveBeenCalledTimes(4);
	});
});
