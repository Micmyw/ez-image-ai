import { describe, expect, it, vi } from "vitest";

import {
	createDatabaseQueryMetrics,
	databaseQueryLogArgs,
	localSqlMetricsEnabled,
} from "./query-metrics";

const localUrl = "postgresql://fixture:secret@127.0.0.1:55432/ezpic_one_second_test";
const hyperdriveUrl = `postgresql://fixture:secret@${"a".repeat(32)}.hyperdrive.local:5432/ezpic_one_second_test?sslmode=disable`;

describe("local SQL diagnostic formats", () => {
	it("retains the same per-query timing and ownership in both formats", () => {
		const objectRows: unknown[] = [];
		const jsonLines: string[] = [];
		const metrics = createDatabaseQueryMetrics({
			clientKind: "request",
			context: {
				runId: "run-1",
				taskId: "media-verify-upload",
				jobId: "job-1",
				assetId: "asset-1",
			},
			now: () => 1000,
			emit: (sample) => {
				objectRows.push(databaseQueryLogArgs(sample, undefined)[1]);
				const args = databaseQueryLogArgs(sample, "jsonl");
				expect(args).toHaveLength(1);
				jsonLines.push(args[0]);
			},
		});
		metrics.observe({ duration: 12.5 });
		metrics.observe({ duration: 0 });
		expect(jsonLines).toHaveLength(2);
		expect(jsonLines.every((line) => !line.includes("\n"))).toBe(true);
		expect(jsonLines.map((line) => JSON.parse(line.slice("media.database.query ".length)))).toEqual(
			objectRows,
		);
		expect(objectRows[0]).toMatchObject({
			startedAt: 987.5,
			completedAt: 1000,
			durationMs: 12.5,
			runId: "run-1",
			taskId: "media-verify-upload",
			jobId: "job-1",
			assetId: "asset-1",
		});
	});

	it.each([undefined, "", "pretty", "JSONL", "false"])(
		"preserves the original object output for format %s",
		(format) => {
			const emit = vi.fn();
			const metrics = createDatabaseQueryMetrics({ clientKind: "node", emit, now: () => 1000 });
			metrics.observe({ duration: 0 });
			const sample = emit.mock.calls[0]![0];
			expect(databaseQueryLogArgs(sample, format)).toEqual(["media.database.query", sample]);
		},
	);
});

describe("isolated local SQL metrics admission", () => {
	it.each([undefined, "", "false", "1", "TRUE"])("does not enable capture for flag %s", (flag) => {
		expect(localSqlMetricsEnabled(localUrl, flag)).toBe(false);
	});
	it.each([
		"postgresql://fixture:secret@database.example:55432/media_test",
		"postgresql://fixture:secret@127.0.0.1:55432/production",
		"postgresql://fixture:secret@127.0.0.1:5432/media_test",
		"postgresql://fixture:secret@127.0.0.1:55432/latest",
		`${localUrl}?host=database.example`,
		`${localUrl}?port=5432`,
		`${localUrl}?database=production`,
		`${localUrl}#diagnostics`,
		"not-a-connection-url",
	])("rejects a connection outside the isolated fixture contract", (url) => {
		expect(localSqlMetricsEnabled(url, "true")).toBe(false);
	});
	it.each([
		localUrl,
		"postgresql://fixture:secret@localhost:55432/scanless_metrics_test",
		"postgres://fixture:secret@[::1]:55439/video_test_metrics",
	])("accepts explicit fixture opt-in", (url) => {
		expect(localSqlMetricsEnabled(url, "true")).toBe(true);
	});
	it("accepts Miniflare's magic binding only with matching explicit local-origin proof", () => {
		expect(localSqlMetricsEnabled(hyperdriveUrl, "true")).toBe(false);
		expect(
			localSqlMetricsEnabled(hyperdriveUrl, "true", {
				hyperdriveFlag: "true",
				originalConnectionString: localUrl,
			}),
		).toBe(true);
	});
	it.each([
		[hyperdriveUrl, "false", localUrl],
		[hyperdriveUrl, "true", undefined],
		[hyperdriveUrl, "true", localUrl.replace("127.0.0.1", "database.example")],
		[hyperdriveUrl, "true", localUrl.replace("55432", "5432")],
		[hyperdriveUrl, "true", localUrl.replace("ezpic_one_second_test", "production")],
		[hyperdriveUrl, "true", localUrl.replace(":secret@", ":changed@")],
		[hyperdriveUrl, "true", localUrl.replace("fixture:", "another:")],
		[hyperdriveUrl, "true", localUrl.replace("ezpic_one_second_test", "different_test")],
		[hyperdriveUrl.replace("sslmode=disable", "sslmode=require"), "true", localUrl],
		[`${hyperdriveUrl}&host=database.example`, "true", localUrl],
		[hyperdriveUrl.replace("5432", "55432"), "true", localUrl],
		[hyperdriveUrl.replace(`${"a".repeat(32)}.hyperdrive.local`, "localhost"), "true", localUrl],
		[hyperdriveUrl.replace(".hyperdrive.local", ".hyperdrive.local.example"), "true", localUrl],
		[hyperdriveUrl.replace("a".repeat(32), "arbitrary"), "true", localUrl],
	] as const)(
		"rejects mismatched or unproven Hyperdrive fixture bindings",
		(url, hyperdriveFlag, originalConnectionString) => {
			expect(
				localSqlMetricsEnabled(url, "true", { hyperdriveFlag, originalConnectionString }),
			).toBe(false);
		},
	);
});

describe("query event numeric projection", () => {
	it("aggregates count and duration without accessing SQL, parameters, or credentials", () => {
		const emit = vi.fn();
		const metrics = createDatabaseQueryMetrics({ clientKind: "request", emit, now: () => 1_000 });
		const event = {
			duration: 12.5,
			get query(): never {
				throw new Error("SQL_MUST_NOT_BE_READ");
			},
			get params(): never {
				throw new Error("PARAMS_MUST_NOT_BE_READ");
			},
			get target(): never {
				throw new Error("TARGET_MUST_NOT_BE_READ");
			},
		};
		metrics.observe(event);
		metrics.observe({ duration: 3 });
		metrics.observe({ duration: 0 });
		expect(metrics.snapshot()).toMatchObject({
			queryCount: 3,
			cumulativeDurationMs: 15.5,
			maximumDurationMs: 12.5,
			invalidDurationEvents: 0,
		});
		expect(emit.mock.calls[0]![0]).toEqual({
			at: 1_000,
			startedAt: 987.5,
			completedAt: 1_000,
			durationMs: 12.5,
			clientScope: expect.stringMatching(/^request:[a-f0-9-]{36}$/),
		});
		expect(Object.keys(emit.mock.calls[0]![0]).sort()).toEqual([
			"at",
			"clientScope",
			"completedAt",
			"durationMs",
			"startedAt",
		]);
		expect(JSON.stringify(emit.mock.calls)).not.toContain("secret");
	});
	it("keeps overlapping clients distinct without deriving identities from user/database contents", () => {
		const first = createDatabaseQueryMetrics({ clientKind: "request", emit: vi.fn() });
		const second = createDatabaseQueryMetrics({ clientKind: "request", emit: vi.fn() });
		const node = createDatabaseQueryMetrics({ clientKind: "node", emit: vi.fn() });
		expect(new Set([first, second, node].map((value) => value.snapshot().clientScope)).size).toBe(
			3,
		);
		expect(node.snapshot().clientScope).toMatch(/^node:/);
	});
	it("captures explicit identities per client before out-of-order concurrent completion", async () => {
		const emit = vi.fn();
		const firstContext = {
			runId: "workflow-first:outbox:event-1",
			taskId: "media-verify-upload",
			jobId: "job-1",
			assetId: "asset-1",
		};
		const first = createDatabaseQueryMetrics({
			clientKind: "request",
			context: firstContext,
			emit,
		});
		const second = createDatabaseQueryMetrics({
			clientKind: "request",
			context: { runId: "workflow-second", taskId: "media-finalize-generation", jobId: "job-2" },
			emit,
		});
		firstContext.runId = "mutated-after-client-creation";
		await Promise.resolve().then(() => second.observe({ duration: 1 }));
		first.observe({ duration: 2 });
		expect(emit.mock.calls[0]![0]).toMatchObject({
			runId: "workflow-second",
			taskId: "media-finalize-generation",
			jobId: "job-2",
		});
		expect(emit.mock.calls[0]![0]).not.toHaveProperty("assetId");
		expect(emit.mock.calls[1]![0]).toMatchObject({
			runId: "workflow-first:outbox:event-1",
			taskId: "media-verify-upload",
			jobId: "job-1",
			assetId: "asset-1",
		});
		expect(emit.mock.calls[0]![0].clientScope).not.toBe(emit.mock.calls[1]![0].clientScope);
	});
	it("ignores non-identity fields without reading their contents", () => {
		const emit = vi.fn();
		const context = {
			taskId: "media-verify-upload",
			get payload(): never {
				throw new Error("PAYLOAD_MUST_NOT_BE_READ");
			},
			get url(): never {
				throw new Error("URL_MUST_NOT_BE_READ");
			},
		};
		const metrics = createDatabaseQueryMetrics({ clientKind: "request", context, emit });
		metrics.observe({ duration: 1 });
		expect(Object.keys(emit.mock.calls[0]![0]).sort()).toEqual([
			"at",
			"clientScope",
			"completedAt",
			"durationMs",
			"startedAt",
			"taskId",
		]);
	});
	it.each([
		"",
		"x".repeat(257),
		"https://private.example/object",
		"has whitespace",
		"x\ny",
		"x?token=secret",
	])("drops invalid identity labels without logging them or failing queries", (value) => {
		const emit = vi.fn();
		const metrics = createDatabaseQueryMetrics({
			clientKind: "request",
			context: { runId: value, taskId: value, jobId: value, assetId: value },
			emit,
		});
		metrics.observe({ duration: 1 });
		expect(Object.keys(emit.mock.calls[0]![0]).sort()).toEqual([
			"at",
			"clientScope",
			"completedAt",
			"durationMs",
			"startedAt",
		]);
	});
	it("does not represent invalid durations as observed zero-cost queries", () => {
		const emit = vi.fn();
		const metrics = createDatabaseQueryMetrics({ clientKind: "node", emit, now: () => 1_000 });
		for (const duration of [NaN, Infinity, -1]) metrics.observe({ duration });
		expect(metrics.snapshot()).toMatchObject({ queryCount: 0, invalidDurationEvents: 3 });
		expect(emit).not.toHaveBeenCalled();
	});
	it("does not propagate diagnostics sink failures", () => {
		const metrics = createDatabaseQueryMetrics({
			clientKind: "node",
			emit: () => {
				throw new Error("SINK_UNAVAILABLE");
			},
		});
		expect(() => metrics.observe({ duration: 5 })).not.toThrow();
		expect(metrics.snapshot().queryCount).toBe(1);
	});
});
