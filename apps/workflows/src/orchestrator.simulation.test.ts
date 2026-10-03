import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { runPolling, runTask, type DurableSteps, type InvokeTask } from "./orchestrator";

// This measures the actual orchestrator with deterministic executor boundaries.
// It is not an end-to-end provider, database, browser or production benchmark.
describe("fixed-delay Outbox handoff simulation", () => {
	it.runIf(process.env.GENERATION_OUTBOX_VERIFY_SAVED_BASELINE === "true")(
		"replays the saved old source with measured start and busy counters, preserving baseline files",
		async () => {
			const directory = resolve(
				process.cwd(),
				process.env.GENERATION_OUTBOX_VERIFY_OUTPUT_DIR ?? "../../.cache/generation-batch1",
			);
			await mkdir(directory, { recursive: true });
			const sourcePath = resolve(
				process.cwd(),
				"../../tooling/e2e/fixtures/generation-batch1/orchestrator-before.ts.txt",
			);
			const beforeSource = await readFile(sourcePath);
			const sourceHash = createHash("sha256").update(beforeSource).digest("hex");
			const afterSource = await readFile(resolve(process.cwd(), "src/orchestrator.ts"));
			// Resolve @repo/jobs from the original workspace, without changing the saved source.
			const replayDirectory = resolve(process.cwd(), ".cache/generation-batch1");
			await mkdir(replayDirectory, { recursive: true });
			const replayPath = resolve(replayDirectory, `orchestrator-before-${sourceHash}.ts`);
			if ((await readIfPresent(replayPath)) === undefined)
				await writeFile(replayPath, beforeSource, { flag: "wx" });
			expect(await readFile(replayPath)).toEqual(beforeSource);
			const before = (await import(/* @vite-ignore */ pathToFileURL(replayPath).href)) as {
				runTask: typeof runTask;
				runPolling: typeof runPolling;
			};
			const baselinePaths = ["outbox-before.json", "outbox-after.json"];
			const originalEvidence = await Promise.all(
				baselinePaths.map((name) => readIfPresent(resolve(directory, name))),
			);
			const sampleCount = 3;
			for (const [phase, implementation] of [
				["before", before],
				["after", { runTask, runPolling }],
			] as const) {
				const results = [];
				for (const scenario of SCENARIOS) {
					const samples = [];
					for (let sample = 0; sample < sampleCount; sample++) {
						samples.push(await replayScenario(implementation, scenario));
					}
					const expectedScans = phase === "after" && scenario.startsWith("duplicate") ? 0 : 1;
					for (const result of samples) {
						expect(result.eventDueToFirstTaskStartMs).toBe(0);
						expect(result.globalOutboxScans).toBe(expectedScans);
						expect(result.maintenanceBusyResponses).toBe(
							phase === "before" && scenario === "duplicate-with-maintenance" ? 1 : 0,
						);
					}
					results.push({ scenario, samples, summary: summarizeSamples(samples) });
				}
				await writeFile(
					resolve(directory, `outbox-${phase}-verified.json`),
					JSON.stringify(
						{
							phase,
							clock: "Vitest virtual time",
							sampleCount,
							conditions:
								"Modules imported once, fresh fixture per sample, one source task at a time; maintenance occupied for the first 1000 ms in that scenario only. No runtime cold-start measurement.",
							fixedDelays: {
								executorCheckMs: 40,
								outboxScanMs: 80,
								maintenanceHoldMs: 1_000,
								pendingWaitMs: 5_000,
							},
							source:
								phase === "before"
									? {
											path: "tooling/e2e/fixtures/generation-batch1/orchestrator-before.ts.txt",
											sha256: sourceHash,
										}
									: {
											path: "apps/workflows/src/orchestrator.ts",
											sha256: createHash("sha256").update(afterSource).digest("hex"),
										},
							scope:
								"Actual archived/current runTask and runPolling; executor and maintenance are simulated. First task due time is fixed at fixture start. Global delivery requested-to-start is a separate synthetic wake-up metric, not business Outbox event latency. Completion tails are not first-image latency.",
							unmeasured: [
								"Production and browser first-image latency",
								"Database connection wait and SQL server execution time",
								"Missed-wakeup recovery timing and accepted-response-loss recovery timing",
								"Waffo, SeeAPI and Kie logical submissions (no providers in this harness)",
							],
							results,
						},
						null,
						2,
					),
				);
			}
			for (const [index, name] of baselinePaths.entries()) {
				expect(await readIfPresent(resolve(directory, name))).toEqual(originalEvidence[index]);
			}
		},
	);
	it("records no-op work, durable pending waits and unchanged transition delivery", async () => {
		const wallStarted = performance.now();
		vi.useFakeTimers();
		const results: Record<string, unknown>[] = [];
		try {
			for (const scenario of [
				"duplicate-verification",
				"duplicate-poll",
				"committed-verification",
				"pending-then-approved",
				"duplicate-with-maintenance",
				"legacy-finalization",
			]) {
				vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
				const started = Date.now();
				let scans = 0;
				let busy = 0;
				let checks = 0;
				const outputs = new Map<string, unknown>();
				const sleeps: string[] = [];
				const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
				const step: DurableSteps = {
					do: async (name, _config, callback) => {
						if (!outputs.has(name)) outputs.set(name, await callback());
						return outputs.get(name) as never;
					},
					sleep: async (_name, duration) => {
						sleeps.push(duration);
						await delay(Number.parseInt(duration, 10) * 1_000);
					},
				};
				const invoke: InvokeTask = async (request) => {
					if (request.taskId === "media-deliver-outbox") {
						if (scenario === "duplicate-with-maintenance" && Date.now() - started < 1_000) {
							busy++;
							return { status: "busy" };
						}
						scans++;
						await delay(80);
						return { status: "ok" };
					}
					checks++;
					await delay(40);
					if (scenario === "legacy-finalization") return { status: "ok" };
					const done = scenario !== "pending-then-approved" || checks === 2;
					return {
						status: "ok",
						poll: {
							done,
							waitSeconds: done ? 0 : 5,
							outboxCommitted:
								done && ["committed-verification", "pending-then-approved"].includes(scenario),
						},
					};
				};
				const request = {
					taskId:
						scenario === "duplicate-poll"
							? "media-poll-generation"
							: scenario === "legacy-finalization"
								? "media-finalize-generation"
								: "media-verify-upload",
					payload: {},
				};
				const execution =
					scenario === "pending-then-approved"
						? runPolling(request, "simulated-run", step, invoke)
						: runTask(request, "simulated-run", step, invoke);
				await vi.runAllTimersAsync();
				await execution;
				results.push({
					scenario,
					virtualDurationMs: Date.now() - started,
					executorChecks: checks,
					globalOutboxScans: scans,
					maintenanceBusyResponses: busy,
					durableSleeps: sleeps,
				});
			}
		} finally {
			vi.useRealTimers();
		}
		expect(results).toHaveLength(6);
		expect(results.find((row) => row.scenario === "pending-then-approved")).toMatchObject({
			executorChecks: 2,
			globalOutboxScans: 1,
			durableSleeps: ["5 seconds"],
		});
		expect(results.find((row) => row.scenario === "legacy-finalization")).toMatchObject({
			globalOutboxScans: 1,
		});
		const phase = process.env.GENERATION_OUTBOX_SIMULATION_PHASE;
		if (phase === "before" || phase === "after") {
			const directory = resolve(process.cwd(), "../../.cache/generation-batch1");
			await mkdir(directory, { recursive: true });
			await writeFile(
				resolve(directory, `outbox-${phase}.json`),
				JSON.stringify(
					{
						phase,
						clock: "Vitest virtual time",
						wallDurationMs: performance.now() - wallStarted,
						fixedDelays: {
							executorCheckMs: 40,
							outboxScanMs: 80,
							maintenanceHoldMs: 1_000,
							pendingWaitMs: 5_000,
						},
						scope:
							"Actual runTask/runPolling; simulated executor and maintenance boundaries. No database, paid provider or browser. Durations measure invocation tails, not first-image latency.",
						results,
					},
					null,
					2,
				),
				phase === "before" ? { flag: "wx" } : undefined,
			);
		}
	});
});

async function readIfPresent(path: string) {
	try {
		return await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

const SCENARIOS = [
	"duplicate-verification",
	"duplicate-poll",
	"committed-verification",
	"pending-then-approved",
	"duplicate-with-maintenance",
	"legacy-finalization",
] as const;

async function replayScenario(
	implementation: { runTask: typeof runTask; runPolling: typeof runPolling },
	scenario: (typeof SCENARIOS)[number],
) {
	vi.useFakeTimers();
	try {
		vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
		const eventDueAt = Date.now();
		const offset = () => Date.now() - eventDueAt;
		let firstTaskStart: number | null = null;
		let deliveryRequested: number | null = null;
		let deliveryStarted: number | null = null;
		let scans = 0;
		let busy = 0;
		let checks = 0;
		let globalDeliveryInvocations = 0;
		const outputs = new Map<string, unknown>();
		const sleeps: string[] = [];
		const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
		const step: DurableSteps = {
			do: async (name, _config, callback) => {
				if (!outputs.has(name)) outputs.set(name, await callback());
				return outputs.get(name) as never;
			},
			sleep: async (_name, duration) => {
				sleeps.push(duration);
				await delay(Number.parseInt(duration, 10) * 1_000);
			},
		};
		const invoke: InvokeTask = async (request) => {
			if (request.taskId === "media-deliver-outbox") {
				globalDeliveryInvocations++;
				deliveryRequested ??= offset();
				if (scenario === "duplicate-with-maintenance" && offset() < 1_000) {
					busy++;
					return { status: "busy" };
				}
				deliveryStarted ??= offset();
				scans++;
				await delay(80);
				return { status: "ok" };
			}
			firstTaskStart ??= offset();
			checks++;
			await delay(40);
			if (scenario === "legacy-finalization") return { status: "ok" };
			const done = scenario !== "pending-then-approved" || checks === 2;
			return {
				status: "ok",
				poll: {
					done,
					waitSeconds: done ? 0 : 5,
					outboxCommitted:
						done && ["committed-verification", "pending-then-approved"].includes(scenario),
				},
			};
		};
		const request = {
			taskId:
				scenario === "duplicate-poll"
					? "media-poll-generation"
					: scenario === "legacy-finalization"
						? "media-finalize-generation"
						: "media-verify-upload",
			payload: {},
			trace: { outboxEventId: "simulated-event-1", dueAt: eventDueAt },
		};
		const execution =
			scenario === "pending-then-approved"
				? implementation.runPolling(request, "simulated-run", step, invoke)
				: implementation.runTask(request, "simulated-run", step, invoke);
		await vi.runAllTimersAsync();
		await execution;
		return {
			virtualDurationMs: offset(),
			eventDueToFirstTaskStartMs: firstTaskStart,
			firstGlobalDeliveryRequestedAtOffsetMs: deliveryRequested,
			firstGlobalDeliveryStartedAtOffsetMs: deliveryStarted,
			globalDeliveryRequestedToStartMs:
				deliveryRequested === null || deliveryStarted === null
					? null
					: deliveryStarted - deliveryRequested,
			executorChecks: checks,
			globalDeliveryInvocations,
			globalOutboxScans: scans,
			ineffectiveGlobalOutboxScans: scenario.startsWith("duplicate") ? scans : 0,
			maintenanceBusyResponses: busy,
			durableSleeps: sleeps,
		};
	} finally {
		vi.useRealTimers();
	}
}

function summarizeSamples(samples: Awaited<ReturnType<typeof replayScenario>>[]) {
	return Object.fromEntries(
		[
			"virtualDurationMs",
			"eventDueToFirstTaskStartMs",
			"globalDeliveryRequestedToStartMs",
			"globalOutboxScans",
			"ineffectiveGlobalOutboxScans",
			"maintenanceBusyResponses",
		].map((key) => {
			const values = samples
				.map((sample) => sample[key as keyof (typeof samples)[number]])
				.filter((value): value is number => typeof value === "number")
				.sort((a, b) => a - b);
			return [
				key,
				values.length
					? {
							median: values[Math.floor(values.length / 2)],
							minimum: values[0],
							maximum: values.at(-1),
						}
					: null,
			];
		}),
	);
}
