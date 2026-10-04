import { describe, expect, it, vi } from "vitest";

import {
	runVideoGenerationV1,
	type VideoDurableSteps,
	type VideoWorkflowServices,
} from "./video-orchestrator";

function fixture() {
	const names: string[] = [];
	const steps: VideoDurableSteps = {
		do: async (name, _config, action) => {
			names.push(name);
			return action();
		},
		waitForEvent: vi.fn(async () => ({})),
		sleep: vi.fn(async () => {}),
	};
	const services: VideoWorkflowServices = {
		checkpoint: vi.fn<VideoWorkflowServices["checkpoint"]>(async () => ({
			stage: "QUEUED",
			terminal: false,
		})),
		window: vi.fn(async (_jobId, _phase, round) => ({ round: round ?? 0, remainingSeconds: 1800 })),
		reviewInput: vi.fn<VideoWorkflowServices["reviewInput"]>(async () => ({ status: "ALLOW" })),
		submit: vi.fn<VideoWorkflowServices["submit"]>(async () => ({
			status: "ACCEPTED",
			attemptId: "attempt",
			providerTaskId: "task",
		})),
		confirm: vi.fn<VideoWorkflowServices["confirm"]>(async () => ({
			status: "SUCCEEDED",
			attemptId: "attempt",
		})),
		store: vi.fn(async () => ({ assetId: "asset", checksum: "hash", byteSize: "1024" })),
		reviewOutput: vi.fn<VideoWorkflowServices["reviewOutput"]>(async () => ({ status: "ALLOW" })),
		finalize: vi.fn<VideoWorkflowServices["finalize"]>(async () => ({
			jobId: "job",
			stage: "READY",
			creditState: "SETTLED",
			credits: "1",
			canPlay: true,
			failureCode: null,
			updatedAt: new Date(0).toISOString(),
		})),
		fail: vi.fn(async () => undefined),
		needsReview: vi.fn(async () => undefined),
		providerPollSeconds: 30,
		moderationPollSeconds: 30,
	};
	return {
		names,
		steps,
		services,
		run: () => runVideoGenerationV1({ jobId: "job", schemaVersion: 1 }, steps, services),
	};
}

describe("direct video V1 workflow", () => {
	it("records repeated 5/10/20-way mock orchestration timings and concurrent entry", async () => {
		const groups: Array<{
			concurrency: number;
			samples: number;
			p50Ms: number;
			p95Ms: number;
			traces: Array<{ totalMs: number; stages: Record<string, number> }>;
		}> = [];
		for (const concurrency of [5, 10, 20]) {
			const traces: Array<{ totalMs: number; stages: Record<string, number> }> = [];
			for (let repetition = 0; repetition < 20; repetition++) {
				let entered = 0;
				let release!: () => void;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				await Promise.all(
					Array.from({ length: concurrency }, async () => {
						const f = fixture();
						const stages: Record<string, number> = {};
						f.steps.do = async (name, _config, action) => {
							const started = performance.now();
							try {
								return await action();
							} finally {
								stages[name] = performance.now() - started;
							}
						};
						vi.mocked(f.services.confirm).mockImplementation(async () => {
							entered++;
							if (entered === concurrency) release();
							await gate;
							return { status: "SUCCEEDED", attemptId: "attempt" };
						});
						const started = performance.now();
						expect((await f.run()).stage).toBe("READY");
						traces.push({ totalMs: performance.now() - started, stages });
						expect(f.services.submit).toHaveBeenCalledTimes(1);
					}),
				);
				expect(entered).toBe(concurrency);
			}
			const sorted = traces.map((t) => t.totalMs).sort((a, b) => a - b);
			groups.push({
				concurrency,
				samples: traces.length,
				p50Ms: sorted[Math.floor(sorted.length * 0.5)]!,
				p95Ms: sorted[Math.floor(sorted.length * 0.95)]!,
				traces,
			});
		}
		const directory = path.resolve(import.meta.dirname, "../../../.cache/video-v1");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			path.join(directory, "mock-workflow-performance.json"),
			JSON.stringify(
				{
					kind: "LOCAL_MOCK_ORCHESTRATION_ONLY",
					paidRequests: 0,
					databaseMs: null,
					providerMs: null,
					storageNetworkMs: null,
					generatedAt: new Date().toISOString(),
					groups,
				},
				null,
				2,
			),
		);
	});
	it("consumes immediate review and executes every stage without fixed sleeps or legacy dispatch", async () => {
		const f = fixture();
		expect(await f.run()).toEqual({ completed: true, stage: "READY" });
		expect(f.steps.waitForEvent).not.toHaveBeenCalled();
		expect(f.names).toContain("video-v1-submit-provider");
		expect(f.names.indexOf("video-v1-submit-provider")).toBe(
			f.names.indexOf("video-v1-review-input-0") + 1,
		);
		expect(new Set(f.names).size).toBe(f.names.length);
	});
	it("uses unique persisted rounds after timeout and queries rather than consuming event payloads", async () => {
		const f = fixture();
		vi.mocked(f.services.confirm)
			.mockResolvedValueOnce({ status: "PENDING" })
			.mockResolvedValueOnce({ status: "PENDING" });
		vi.mocked(f.steps.waitForEvent).mockRejectedValueOnce(
			Object.assign(new Error("expired"), { name: "WorkflowTimeoutError" }),
		);
		await f.run();
		expect(f.names.filter((name) => name.includes("confirm-provider"))).toEqual([
			"video-v1-confirm-provider-0",
			"video-v1-confirm-provider-1",
			"video-v1-confirm-provider-2",
		]);
		expect(f.steps.waitForEvent).toHaveBeenCalledWith("video-v1-provider-event-0", {
			type: "provider-result",
			timeout: "30 seconds",
		});
		expect(f.services.submit).toHaveBeenCalledTimes(1);
	});
	it("does not swallow non-timeout event errors", async () => {
		const f = fixture();
		vi.mocked(f.services.confirm).mockResolvedValue({ status: "PENDING" });
		vi.mocked(f.steps.waitForEvent).mockRejectedValue(new Error("BAD_EVENT_CONFIGURATION"));
		await expect(f.run()).rejects.toThrow("BAD_EVENT_CONFIGURATION");
		expect(f.services.confirm).toHaveBeenCalledTimes(1);
	});
	it("waits the full callback deadline and confirms once without trusting event evidence", async () => {
		const f = fixture();
		const step = vi.spyOn(f.steps, "do");
		vi.mocked(f.services.reviewOutput).mockResolvedValueOnce({
			status: "PENDING",
			waitFor: "callback",
			retryAfterSeconds: 1,
		});
		vi.mocked(f.steps.waitForEvent).mockResolvedValue({
			decision: "ALLOW",
			assetUrl: "forged-event-data",
		});
		expect(await f.run()).toEqual({ completed: true, stage: "READY" });
		expect(f.steps.waitForEvent).toHaveBeenCalledExactlyOnceWith("video-v1-output-event-0", {
			type: "moderation-result",
			timeout: "1800 seconds",
		});
		expect(f.services.reviewOutput).toHaveBeenCalledTimes(2);
		expect(f.services.reviewOutput).toHaveBeenLastCalledWith("job");
		expect(step).toHaveBeenCalledWith(
			"video-v1-review-output-1",
			expect.objectContaining({ retries: expect.objectContaining({ limit: 0 }) }),
			expect.any(Function),
		);
		expect(f.services.submit).toHaveBeenCalledTimes(1);
	});
	it.each([
		Object.assign(new Error("expired"), { name: "WorkflowTimeoutError" }),
		new Error("Execution timed out after 1800000ms"),
	])(
		"parks callback timeout without a confirmation query, finalization or credit release",
		async (error) => {
			const f = fixture();
			vi.mocked(f.services.reviewOutput).mockResolvedValue({
				status: "PENDING",
				waitFor: "callback",
			});
			vi.mocked(f.steps.waitForEvent).mockRejectedValue(error);
			expect(await f.run()).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
			expect(f.services.reviewOutput).toHaveBeenCalledTimes(1);
			expect(f.services.needsReview).toHaveBeenCalledWith("job", "OUTPUT_REVIEW_CALLBACK_DEADLINE");
			expect(f.services.finalize).not.toHaveBeenCalled();
			expect(f.services.fail).not.toHaveBeenCalled();
			expect(f.services.submit).toHaveBeenCalledTimes(1);
		},
	);
	it("parks an already expired callback window without any event wait or confirmation", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewOutput).mockResolvedValue({
			status: "PENDING",
			waitFor: "callback",
		});
		vi.mocked(f.services.window).mockResolvedValue({ round: 0, remainingSeconds: 0 });
		expect(await f.run()).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
		expect(f.steps.waitForEvent).not.toHaveBeenCalled();
		expect(f.services.reviewOutput).toHaveBeenCalledTimes(1);
		expect(f.services.needsReview).toHaveBeenCalledWith("job", "OUTPUT_REVIEW_CALLBACK_DEADLINE");
	});
	it("rejects an expired absolute deadline even when replayed relative seconds are stale", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewOutput).mockResolvedValue({
			status: "PENDING",
			waitFor: "callback",
		});
		vi.mocked(f.services.window).mockResolvedValue({
			round: 0,
			remainingSeconds: 1800,
			deadlineAt: new Date(0).toISOString(),
		});
		expect(await f.run()).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
		expect(f.steps.waitForEvent).not.toHaveBeenCalled();
		expect(f.services.reviewOutput).toHaveBeenCalledTimes(1);
		expect(f.services.finalize).not.toHaveBeenCalled();
	});
	it("does not confirm a callback waking after the immutable absolute deadline", async () => {
		const f = fixture();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		try {
			vi.mocked(f.services.reviewOutput).mockResolvedValue({
				status: "PENDING",
				waitFor: "callback",
			});
			vi.mocked(f.services.window).mockResolvedValue({
				round: 0,
				remainingSeconds: 1800,
				deadlineAt: new Date(11000).toISOString(),
			});
			vi.mocked(f.steps.waitForEvent).mockImplementation(async () => {
				clock.mockReturnValue(11001);
				return {};
			});
			expect(await f.run()).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
			expect(f.steps.waitForEvent).toHaveBeenCalledExactlyOnceWith("video-v1-output-event-0", {
				type: "moderation-result",
				timeout: "10 seconds",
			});
			expect(f.services.reviewOutput).toHaveBeenCalledTimes(1);
			expect(f.services.needsReview).toHaveBeenCalledWith("job", "OUTPUT_REVIEW_CALLBACK_DEADLINE");
		} finally {
			clock.mockRestore();
		}
	});
	it("preserves the completed callback path when durable steps replay after the deadline", async () => {
		const f = fixture();
		const completedSteps = new Map<string, unknown>();
		f.steps.do = async (name, _options, action) => {
			if (completedSteps.has(name))
				return completedSteps.get(name) as Awaited<ReturnType<typeof action>>;
			const value = await action();
			completedSteps.set(name, value);
			return value;
		};
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		try {
			vi.mocked(f.services.reviewOutput).mockResolvedValueOnce({
				status: "PENDING",
				waitFor: "callback",
			});
			vi.mocked(f.services.window).mockResolvedValue({
				round: 0,
				remainingSeconds: 10,
				deadlineAt: new Date(11000).toISOString(),
			});
			expect((await f.run()).stage).toBe("READY");
			clock.mockReturnValue(12000);
			// Like workerd, this fixture returns the already persisted event and steps.
			expect((await f.run()).stage).toBe("READY");
			expect(f.services.reviewOutput).toHaveBeenCalledTimes(2);
			expect(f.services.finalize).toHaveBeenCalledTimes(1);
			expect(f.services.needsReview).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});
	it("does not extend a callback deadline after a crash between the wait checkpoint and event registration", async () => {
		const f = fixture();
		const completedSteps = new Map<string, unknown>();
		f.steps.do = async (name, _options, action) => {
			if (completedSteps.has(name))
				return completedSteps.get(name) as Awaited<ReturnType<typeof action>>;
			const value = await action();
			completedSteps.set(name, value);
			return value;
		};
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		try {
			vi.mocked(f.services.reviewOutput).mockResolvedValue({
				status: "PENDING",
				waitFor: "callback",
			});
			vi.mocked(f.services.window).mockResolvedValue({
				round: 0,
				remainingSeconds: 10,
				deadlineAt: new Date(11000).toISOString(),
			});
			vi.mocked(f.steps.waitForEvent)
				.mockRejectedValueOnce(new Error("SIMULATED_WORKFLOW_INTERRUPTION"))
				.mockRejectedValueOnce(new Error("Execution timed out after 10000ms"));
			await expect(f.run()).rejects.toThrow("SIMULATED_WORKFLOW_INTERRUPTION");
			clock.mockReturnValue(12000);
			expect((await f.run()).stage).toBe("NEEDS_REVIEW");
			expect(f.steps.waitForEvent).toHaveBeenLastCalledWith("video-v1-output-event-0", {
				type: "moderation-result",
				timeout: "1 seconds",
			});
			expect(f.services.reviewOutput).toHaveBeenCalledTimes(1);
			expect(f.services.finalize).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});
	it("never schedules another callback confirmation after an error marked retryable", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewOutput)
			.mockResolvedValueOnce({ status: "PENDING", waitFor: "callback" })
			.mockResolvedValueOnce({
				status: "ERROR",
				reasonCode: "MODERATION_UNAVAILABLE",
				retryable: true,
			});
		expect(await f.run()).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
		expect(f.services.reviewOutput).toHaveBeenCalledTimes(2);
		expect(f.steps.waitForEvent).toHaveBeenCalledTimes(1);
		expect(f.services.needsReview).toHaveBeenCalledWith("job", "MODERATION_UNAVAILABLE");
		expect(f.services.finalize).not.toHaveBeenCalled();
	});
	it("parks a failed single-attempt callback step without retrying or releasing credits", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewOutput)
			.mockResolvedValueOnce({ status: "PENDING", waitFor: "callback" })
			.mockRejectedValueOnce(new Error("RESPONSE_LOST_AFTER_DURABLE_CLAIM"));
		expect(await f.run()).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
		expect(f.services.reviewOutput).toHaveBeenCalledTimes(2);
		expect(f.services.needsReview).toHaveBeenCalledWith(
			"job",
			"OUTPUT_REVIEW_CALLBACK_CONFIRMATION_FAILED",
		);
		expect(f.services.fail).not.toHaveBeenCalled();
		expect(f.services.finalize).not.toHaveBeenCalled();
	});
	it("waits again after irrelevant wakeups using the remaining durable deadline", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewOutput)
			.mockResolvedValueOnce({ status: "PENDING", waitFor: "callback" })
			.mockResolvedValueOnce({ status: "PENDING", waitFor: "callback" });
		vi.mocked(f.services.window).mockImplementation(async (_jobId, phase, round) => ({
			round: round ?? 0,
			remainingSeconds: phase === "output" ? 1800 - (round ?? 0) * 100 : 1800,
		}));
		expect(await f.run()).toEqual({ completed: true, stage: "READY" });
		expect(f.steps.waitForEvent).toHaveBeenNthCalledWith(1, "video-v1-output-event-0", {
			type: "moderation-result",
			timeout: "1700 seconds",
		});
		expect(f.steps.waitForEvent).toHaveBeenNthCalledWith(2, "video-v1-output-event-1", {
			type: "moderation-result",
			timeout: "1600 seconds",
		});
		expect(f.services.reviewOutput).toHaveBeenCalledTimes(3);
		expect(f.services.submit).toHaveBeenCalledTimes(1);
	});
	it("preserves legacy review retries and polling intervals without callback mode", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewOutput).mockResolvedValueOnce({
			status: "ERROR",
			reasonCode: "MODERATION_UNAVAILABLE",
			retryable: true,
		});
		expect(await f.run()).toEqual({ completed: true, stage: "READY" });
		expect(f.steps.waitForEvent).toHaveBeenCalledExactlyOnceWith("video-v1-output-event-0", {
			type: "moderation-result",
			timeout: "30 seconds",
		});
		expect(f.services.reviewOutput).toHaveBeenCalledTimes(2);
	});
	it("uses durable 1/3-second sleeps for transient confirmations without callback bypass or resubmission", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewOutput)
			.mockResolvedValueOnce({ status: "PENDING", waitFor: "callback" })
			.mockResolvedValueOnce({
				status: "PENDING",
				waitFor: "confirmation-retry",
				retryAfterSeconds: 1,
			})
			.mockResolvedValueOnce({
				status: "PENDING",
				waitFor: "confirmation-retry",
				retryAfterSeconds: 3,
			});
		expect((await f.run()).stage).toBe("READY");
		expect(f.steps.waitForEvent).toHaveBeenCalledTimes(1);
		expect(f.steps.sleep).toHaveBeenNthCalledWith(
			1,
			"video-v1-output-confirmation-retry-1",
			"1 seconds",
		);
		expect(f.steps.sleep).toHaveBeenNthCalledWith(
			2,
			"video-v1-output-confirmation-retry-2",
			"3 seconds",
		);
		expect(f.services.reviewOutput).toHaveBeenCalledTimes(4);
		expect(f.services.submit).toHaveBeenCalledTimes(1);
	});
	it("parks exhausted confirmation attempts from the database instead of another sleep or query", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewOutput)
			.mockResolvedValueOnce({
				status: "PENDING",
				waitFor: "confirmation-retry",
				retryAfterSeconds: 1,
			})
			.mockResolvedValueOnce({
				status: "PENDING",
				waitFor: "confirmation-retry",
				retryAfterSeconds: 3,
			})
			.mockResolvedValueOnce({
				status: "ERROR",
				reasonCode: "VIDEO_CALLBACK_CONFIRMATION_EXHAUSTED",
				retryable: false,
			});
		expect((await f.run()).stage).toBe("NEEDS_REVIEW");
		expect(f.steps.waitForEvent).not.toHaveBeenCalled();
		expect(f.steps.sleep).toHaveBeenCalledTimes(2);
		expect(f.services.reviewOutput).toHaveBeenCalledTimes(3);
		expect(f.services.finalize).not.toHaveBeenCalled();
		expect(f.services.fail).not.toHaveBeenCalled();
	});
	it("checks the absolute deadline after confirmation backoff before another read attempt", async () => {
		const f = fixture();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		try {
			vi.mocked(f.services.reviewOutput).mockResolvedValue({
				status: "PENDING",
				waitFor: "confirmation-retry",
				retryAfterSeconds: 3,
			});
			vi.mocked(f.services.window).mockResolvedValue({
				round: 0,
				remainingSeconds: 1800,
				deadlineAt: new Date(2000).toISOString(),
			});
			vi.mocked(f.steps.sleep).mockImplementation(async () => {
				clock.mockReturnValue(2001);
			});
			expect((await f.run()).stage).toBe("NEEDS_REVIEW");
			expect(f.steps.sleep).toHaveBeenCalledExactlyOnceWith(
				"video-v1-output-confirmation-retry-0",
				"1 seconds",
			);
			expect(f.services.reviewOutput).toHaveBeenCalledTimes(1);
			expect(f.services.needsReview).toHaveBeenCalledWith("job", "OUTPUT_REVIEW_CALLBACK_DEADLINE");
		} finally {
			clock.mockRestore();
		}
	});
	it("honors the persisted active-read lease instead of waking every short retry interval", async () => {
		const f = fixture();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		try {
			vi.mocked(f.services.reviewOutput).mockResolvedValueOnce({
				status: "PENDING",
				waitFor: "confirmation-retry",
				retryAfterSeconds: 1,
				nextRetryAt: new Date(61000).toISOString(),
			});
			vi.mocked(f.steps.sleep).mockImplementation(async () => {
				clock.mockReturnValue(61000);
			});
			expect((await f.run()).stage).toBe("READY");
			expect(f.steps.sleep).toHaveBeenCalledExactlyOnceWith(
				"video-v1-output-confirmation-retry-0",
				"60 seconds",
			);
			expect(f.steps.waitForEvent).not.toHaveBeenCalled();
			expect(f.services.reviewOutput).toHaveBeenCalledTimes(2);
		} finally {
			clock.mockRestore();
		}
	});
	it("does not restart elapsed persisted backoff and rejects an invalid retry timestamp", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewOutput).mockResolvedValueOnce({
			status: "PENDING",
			waitFor: "confirmation-retry",
			retryAfterSeconds: 3,
			nextRetryAt: new Date(0).toISOString(),
		});
		expect((await f.run()).stage).toBe("READY");
		expect(f.steps.sleep).not.toHaveBeenCalled();
		const invalid = fixture();
		vi.mocked(invalid.services.reviewOutput).mockResolvedValue({
			status: "PENDING",
			waitFor: "confirmation-retry",
			nextRetryAt: "invalid",
		});
		expect((await invalid.run()).stage).toBe("NEEDS_REVIEW");
		expect(invalid.steps.sleep).not.toHaveBeenCalled();
		expect(invalid.services.reviewOutput).toHaveBeenCalledTimes(1);
	});
	it("reconciles uncertain acceptance within its durable deadline without resubmission or release", async () => {
		const f = fixture();
		vi.mocked(f.services.submit).mockResolvedValue({
			status: "UNCERTAIN",
			attemptId: "a",
			reasonCode: "RESPONSE_LOST",
		});
		vi.mocked(f.services.confirm).mockResolvedValue({ status: "PENDING" });
		vi.mocked(f.services.window).mockResolvedValue({ round: 8, remainingSeconds: 0 });
		expect(await f.run()).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
		expect(f.services.needsReview).toHaveBeenCalledWith("job", "PROVIDER_DEADLINE");
		expect(f.services.fail).not.toHaveBeenCalled();
		expect(f.services.submit).toHaveBeenCalledTimes(1);
	});
	it("resumes storage only, preserving the paid generation", async () => {
		const f = fixture();
		vi.mocked(f.services.checkpoint).mockResolvedValue({ stage: "STORING", terminal: false });
		await f.run();
		expect(f.services.submit).not.toHaveBeenCalled();
		expect(f.services.confirm).not.toHaveBeenCalled();
		expect(f.services.store).toHaveBeenCalledTimes(1);
	});
	it("rejects input without any generation or transfer", async () => {
		const f = fixture();
		vi.mocked(f.services.reviewInput).mockResolvedValue({
			status: "REJECT",
			reasonCode: "POLICY_REJECTED",
		});
		expect(await f.run()).toEqual({ completed: true, stage: "REJECTED" });
		expect(f.services.fail).toHaveBeenCalledWith("job", "POLICY_REJECTED", true);
		expect(f.services.submit).not.toHaveBeenCalled();
		expect(f.services.store).not.toHaveBeenCalled();
	});
	it.each([5, 10, 20])(
		"allows %i mock workflows to progress independently without a global slot",
		async (count) => {
			const fixtures = Array.from({ length: count }, fixture);
			const results = await Promise.all(fixtures.map((f) => f.run()));
			expect(results.every((result) => result.stage === "READY")).toBe(true);
			for (const f of fixtures) expect(f.services.submit).toHaveBeenCalledTimes(1);
		},
	);
});
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
