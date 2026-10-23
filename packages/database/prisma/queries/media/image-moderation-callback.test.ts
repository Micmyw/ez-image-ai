import { describe, expect, it, vi } from "vitest";

import { createCallbackDatabaseTiming } from "./callback-timing";
import { imageModerationRetryAt, wakeImageModeration } from "./image-moderation-callback";

const identity = { assetId: "asset", generation: 2, submissionToken: "submission" };
function fixture(patch = {}) {
	const asset = {
		id: "asset",
		verificationEngine: "legacy",
		verificationProvider: "seeapi",
		mimeType: "image/png",
		verificationGeneration: 2,
		verificationSubmissionToken: "submission",
		status: "VERIFYING",
		deletedAt: null,
		deleteAfter: null,
		verificationProviderTaskId: "provider-task",
		verificationSubmissionUncertain: false,
		verificationLeasedUntil: null,
		verificationNextAttemptAt: new Date(Date.now() + 60_000),
		verificationCallbackReceivedAt: null as Date | null,
		...patch,
	};
	const tx = {
		$executeRaw: vi.fn(),
		mediaAsset: {
			findUnique: vi.fn(async () => asset),
			update: vi.fn(async ({ data }: { data: Partial<typeof asset> }) =>
				Object.assign(asset, data),
			),
		},
	};
	const client = { $transaction: async (run: (input: typeof tx) => unknown) => run(tx) };
	return { asset, tx, wake: () => wakeImageModeration(identity, client as never) };
}
describe("image review completion wake", () => {
	it("records a completion wake and advances only the existing attempt under the lock", async () => {
		const f = fixture();
		expect(await f.wake()).toBe("ready");
		expect(f.tx.$executeRaw).toHaveBeenCalled();
		expect(f.tx.mediaAsset.update).toHaveBeenCalledWith({
			where: { id: "asset" },
			data: {
				verificationCallbackReceivedAt: expect.any(Date),
				verificationNextAttemptAt: expect.any(Date),
			},
		});
		expect(f.asset.verificationCallbackReceivedAt).toEqual(f.asset.verificationNextAttemptAt);
	});
	it.each([
		{ verificationEngine: "video-v1" },
		{ verificationGeneration: 3 },
		{ verificationSubmissionToken: "another" },
		{ verificationProvider: "retired" },
		{ mimeType: "video/mp4" },
	])("rejects cross-engine or stale attempt identity %j", async (patch) => {
		const f = fixture(patch);
		expect(await f.wake()).toBe("invalid");
		expect(f.tx.mediaAsset.update).not.toHaveBeenCalled();
	});
	it.each([
		{ verificationProviderTaskId: null },
		{ verificationSubmissionUncertain: true },
		{ verificationLeasedUntil: new Date(Date.now() + 60_000) },
	])("durably records a callback racing an active submission/query %j", async (patch) => {
		const f = fixture(patch);
		const before = { ...f.asset };
		expect(await f.wake()).toBe("recorded");
		expect(f.asset.verificationCallbackReceivedAt).toBeInstanceOf(Date);
		expect({ ...f.asset, verificationCallbackReceivedAt: null }).toEqual(before);
		expect(await f.wake()).toBe("recorded");
		expect(f.tx.mediaAsset.update).toHaveBeenCalledTimes(1);
	});
	it("retries a lost fast wake without writing another signal", async () => {
		const f = fixture();
		expect(await f.wake()).toBe("ready");
		const receivedAt = f.asset.verificationCallbackReceivedAt;
		expect(await f.wake()).toBe("ready");
		expect(f.asset.verificationCallbackReceivedAt).toBe(receivedAt);
		expect(f.tx.mediaAsset.update).toHaveBeenCalledTimes(1);
	});
	it("does not let duplicate notifications accelerate a query that already consumed the signal", async () => {
		const f = fixture();
		expect(await f.wake()).toBe("ready");
		const receivedAt = f.asset.verificationCallbackReceivedAt;
		const nextQueryAt = new Date(Date.now() + 60_000);
		f.asset.verificationNextAttemptAt = nextQueryAt;
		expect(await f.wake()).toBe("recorded");
		expect(f.asset.verificationNextAttemptAt).toBe(nextQueryAt);
		expect(f.asset.verificationCallbackReceivedAt).toBe(receivedAt);
		expect(f.tx.mediaAsset.update).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ status: "READY" },
		{ status: "QUARANTINED" },
		{ deletedAt: new Date() },
		{ deleteAfter: new Date(0) },
	])("never revives resolved or expired media %j", async (patch) => {
		const f = fixture(patch);
		expect(await f.wake()).toBe("terminal");
		expect(f.tx.mediaAsset.update).not.toHaveBeenCalled();
	});
});

describe("image review PENDING commit after a completion notification", () => {
	const now = new Date("2026-10-22T08:00:01Z");
	const callbackReceivedAt = new Date("2026-10-22T08:00:00Z");
	const retryAt = new Date("2026-10-22T08:00:31Z");
	const pending = {
		now,
		retryAt,
		callbackReceivedAt,
		claimedCallbackReceivedAt: null,
		providerTaskId: "review-task",
		submissionUncertain: false,
		pending: true,
	};
	it("keeps a callback that raced the query immediately due instead of sleeping", () => {
		expect(imageModerationRetryAt(pending)).toBe(now);
	});
	it("honors the normal retry after a query has already observed this callback", () => {
		expect(
			imageModerationRetryAt({
				...pending,
				claimedCallbackReceivedAt: new Date(callbackReceivedAt),
			}),
		).toBe(retryAt);
	});
	it.each([
		{ callbackReceivedAt: null },
		{ providerTaskId: null },
		{ submissionUncertain: true },
		{ pending: false },
	])("preserves polling, uncertainty and error backoff %j", (patch) => {
		expect(imageModerationRetryAt({ ...pending, ...patch })).toBe(retryAt);
	});
	it("cannot revive exhausted verification", () => {
		expect(imageModerationRetryAt({ ...pending, retryAt: null })).toBeNull();
	});
	it("does not postpone an already due retry", () => {
		const earlier = new Date(now.getTime() - 1_000);
		expect(imageModerationRetryAt({ ...pending, retryAt: earlier })).toBe(earlier);
	});
});

describe("callback transaction observations", () => {
	it("separates transaction acquisition, lock, query and commit acknowledgement", async () => {
		let now = 10;
		const onTiming = vi.fn();
		const timing = createCallbackDatabaseTiming({ onTiming }, () => now);
		const result = await timing.transaction(
			async (body) => {
				now += 100;
				const value = await body({});
				now += 20;
				return value;
			},
			async () => {
				await timing.measure("lock", async () => {
					now += 30;
				});
				await timing.measure("read", async () => {
					now += 40;
				});
				return "ready";
			},
		);
		expect(result).toBe("ready");
		expect(onTiming.mock.calls).toEqual([
			["transaction-start", 100, "ok"],
			["lock", 30, "ok"],
			["read", 40, "ok"],
			["transaction-finish", 20, "ok"],
		]);
	});
	it.each(["start", "body", "commit"] as const)(
		"never replays a transaction after a %s failure",
		async (stage) => {
			const failure = new Error("private database error");
			const onTiming = vi.fn();
			const timing = createCallbackDatabaseTiming({ onTiming });
			const body = vi.fn(async () => {
				if (stage === "body") throw failure;
				return "ready";
			});
			const run = vi.fn(async (operation: (client: object) => Promise<string>) => {
				if (stage === "start") throw failure;
				const value = await operation({});
				if (stage === "commit") throw failure;
				return value;
			});
			await expect(timing.transaction(run, body)).rejects.toBe(failure);
			expect(run).toHaveBeenCalledOnce();
			expect(body).toHaveBeenCalledTimes(stage === "start" ? 0 : 1);
			expect(onTiming).toHaveBeenLastCalledWith(
				stage === "start" ? "transaction-start" : "transaction-finish",
				expect.any(Number),
				"error",
			);
			expect(JSON.stringify(onTiming.mock.calls)).not.toContain("private");
		},
	);
	it("cannot turn a successful commit into a retry when diagnostics fail", async () => {
		const timing = createCallbackDatabaseTiming({
			onTiming() {
				throw new Error("sink failure");
			},
		});
		await expect(
			timing.transaction(
				(body) => body({}),
				() => timing.measure("persist", async () => "ready"),
			),
		).resolves.toBe("ready");
	});
});
