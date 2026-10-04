import { describe, expect, it, vi } from "vitest";

import { recoverVideoExecutions, type VideoRecoveryDependencies } from "./recovery";

const defaultSeeapi = vi.hoisted(() => vi.fn(async () => ({ notified: 2, failed: 1 })));
const defaultCandidates = vi.hoisted(() =>
	vi.fn(async () => [
		{ jobId: "recovery-job", workflowInstanceId: "video-v1-recovery-job", startState: "STARTED" },
	]),
);
vi.mock("./seeapi-webhooks", () => ({ notifyPendingSeeapiVideoModerationEvents: defaultSeeapi }));
vi.mock("@repo/database/video-v1-execution", () => ({
	listPendingVideoWebhookEvents: vi.fn(async () => []),
	markVideoWebhookNotified: vi.fn(),
	postponeVideoWebhookNotification: vi.fn(),
}));
vi.mock("@repo/database/video-v1-recovery", () => ({
	listVideoRecoveryCandidates: defaultCandidates,
	markVideoNeedsReview: vi.fn(),
	postponeVideoRecovery: vi.fn(),
}));

function fixture() {
	const instance = {
		status: vi.fn(async () => ({ status: "waiting" })),
		sendEvent: vi.fn(async () => undefined),
	};
	const binding = {
		create: vi.fn(async () => instance),
		get: vi.fn(async () => instance),
	};
	const deps: VideoRecoveryDependencies = {
		candidates: vi.fn(async () => []),
		start: vi.fn<VideoRecoveryDependencies["start"]>(async () => "STARTED"),
		postpone: vi.fn(async () => undefined),
		postponeEvent: vi.fn(async () => undefined),
		needsReview: vi.fn(async () => undefined),
		events: vi.fn(async () => []),
		notified: vi.fn(async () => undefined),
		moderationEvents: vi.fn(async () => ({ notified: 0, failed: 0 })),
	};
	return { instance, binding, deps };
}
describe("video recovery direct binding", () => {
	it("redelivers only the persisted SeeAPI moderation inbox through the default recovery wiring", async () => {
		const f = fixture();
		expect(await recoverVideoExecutions(25, f.binding)).toEqual({
			inspected: 1,
			started: 0,
			notified: 2,
			failed: 1,
		});
		expect(defaultSeeapi).toHaveBeenCalledExactlyOnceWith({
			jobId: "recovery-job",
			binding: f.binding,
			limit: 25,
		});
		expect(f.binding.create).not.toHaveBeenCalled();
	});
	it("never scans moderation events without a video recovery candidate", async () => {
		const f = fixture();
		await recoverVideoExecutions(25, f.binding, f.deps);
		expect(f.deps.moderationEvents).not.toHaveBeenCalled();
	});
	it("does not notify moderation events for a mismatched execution identity", async () => {
		const f = fixture();
		vi.mocked(f.deps.candidates).mockResolvedValue([
			{ jobId: "j", workflowInstanceId: "legacy-j", startState: "STARTED" },
		]);
		expect((await recoverVideoExecutions(25, f.binding, f.deps)).failed).toBe(1);
		expect(f.deps.moderationEvents).not.toHaveBeenCalled();
		expect(f.binding.get).not.toHaveBeenCalled();
	});
	it("finds the same missing startup instance and redelivers an unnotified durable inbox", async () => {
		const f = fixture();
		vi.mocked(f.deps.candidates).mockResolvedValue([
			{ jobId: "j", workflowInstanceId: "video-v1-j", startState: "PENDING" },
		]);
		vi.mocked(f.deps.events).mockResolvedValue([
			{ jobId: "j", workflowInstanceId: "video-v1-j", eventId: "e" },
		]);
		expect(await recoverVideoExecutions(25, f.binding, f.deps)).toEqual({
			inspected: 1,
			started: 1,
			notified: 1,
			failed: 0,
		});
		expect(f.deps.start).toHaveBeenCalledWith("j", f.binding);
		expect(f.binding.get).toHaveBeenCalledWith("video-v1-j");
		expect(f.instance.sendEvent).toHaveBeenCalledWith({
			type: "provider-result",
			payload: { jobId: "j", eventId: "e" },
		});
	});
	it("does not acknowledge a failed notification and can retry the same event", async () => {
		const f = fixture();
		vi.mocked(f.deps.events).mockResolvedValue([
			{ jobId: "j", workflowInstanceId: "video-v1-j", eventId: "e" },
		]);
		f.instance.sendEvent.mockRejectedValueOnce(new Error("UNAVAILABLE"));
		expect((await recoverVideoExecutions(25, f.binding, f.deps)).failed).toBe(1);
		expect(f.deps.notified).not.toHaveBeenCalled();
		expect(f.deps.postponeEvent).toHaveBeenCalledWith("e");
		expect((await recoverVideoExecutions(25, f.binding, f.deps)).notified).toBe(1);
		expect(f.binding.create).not.toHaveBeenCalled();
	});
	it.each(["errored", "terminated", "complete", "unknown"])(
		"preserves the attempt for operator review after platform %s instead of restarting paid stages",
		async (status) => {
			const f = fixture();
			f.instance.status.mockResolvedValue({ status });
			vi.mocked(f.deps.candidates).mockResolvedValue([
				{ jobId: "j", workflowInstanceId: "video-v1-j", startState: "STARTED" },
			]);
			await recoverVideoExecutions(25, f.binding, f.deps);
			expect(f.deps.needsReview).toHaveBeenCalledWith("j", `WORKFLOW_${status.toUpperCase()}`);
			expect(f.binding.create).not.toHaveBeenCalled();
			expect(f.deps.start).not.toHaveBeenCalled();
			expect(f.deps.moderationEvents).not.toHaveBeenCalled();
		},
	);
	it("continues accepted work with admission closed and caps a recovery page at 100", async () => {
		const f = fixture();
		vi.stubEnv("VIDEO_V1_ENABLED", "false");
		try {
			vi.mocked(f.deps.candidates).mockResolvedValue([
				{ jobId: "j", workflowInstanceId: "video-v1-j", startState: "PENDING" },
			]);
			await recoverVideoExecutions(2000, f.binding, f.deps);
			expect(f.deps.candidates).toHaveBeenCalledWith(100);
			expect(f.deps.start).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
