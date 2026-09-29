import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ active: undefined as any }));
vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getSession: async () => {
				await harness.active.operation("identity");
				return { user: { id: "owner" }, session: { id: "simulation-session" } };
			},
		},
	},
}));
vi.mock("@repo/database/client", () => ({
	db: new Proxy({}, { get: (_target, key) => harness.active.database[key] }),
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	findGenerationSubmissionQuote: (owner: string, quoteId: string) =>
		harness.active.dependencies.findQuote(owner, quoteId),
	createGenerationJobTransaction: (input: unknown) =>
		harness.active.createJobDependencies.createGenerationJob(input),
}));
vi.mock("@repo/database/media-quotes", async (original) => ({
	...(await original<typeof import("@repo/database/media-quotes")>()),
	createModeratedGenerationQuoteTransaction: (input: unknown) =>
		harness.active.createQuoteDependencies.persistApproved(input),
}));
vi.mock("../lib/text-moderation", async (original) => ({
	...(await original<typeof import("../lib/text-moderation")>()),
	createTextModerationAdapter: () => harness.active.createQuoteDependencies.createAdapter(),
}));
vi.mock("@repo/jobs", () => ({
	resolveDatabaseDispatchRoute: async () => {
		await harness.active.operation("dispatchRoute");
		return {
			taskId: "media-dispatch-generation",
			provider: "kie",
			providerModelId: "nano-banana-2",
		};
	},
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/jobs/orchestration/client", () => ({
	dispatchJob: (_task: string, payload: { jobId: string; version: number }) =>
		harness.active.dependencies.dispatch({
			job: { id: payload.jobId, version: payload.version },
			replayed: false,
		}),
}));
vi.mock("../lib/rate-limit", () => ({
	enforceMediaRateLimit: () => harness.active.operation("rateLimit"),
}));
vi.mock("../lib/free-plan-credits", () => ({
	ensureFreePlanCreditsForUser: () => harness.active.operation("freeGrant"),
}));
vi.mock("../lib/plan-entitlement", () => ({
	loadUserPlanEntitlement: async () => {
		await harness.active.operation("entitlement");
		return { id: "free", maximumConcurrentJobs: 1 };
	},
}));

import { logger } from "@repo/logs";

import { loadCurrentGenerationAdmission } from "../../../../database/prisma/queries/media/generation-admission";
import { dispatchGeneration } from "../../../../jobs/src/handlers/dispatch-generation";
import { getCurrentExecutableRouteGraphOptions } from "../lib/executable-route-graph";
import { createFlowTiming } from "../lib/flow-timing";
import { assertGenerationAllowed } from "../lib/generation-authorization";
import { loadUserPlanEntitlement } from "../lib/plan-entitlement";
import { enforceMediaRateLimit } from "../lib/rate-limit";
import { createGenerationForUser, createGenerationFromApprovedQuote } from "./create-generation";
import { createQuoteForUser } from "./create-quote";
import {
	submitGeneration,
	submitGenerationForUser,
	submitGenerationInputSchema,
} from "./submit-generation";

const INPUT = submitGenerationInputSchema.parse({
	productKey: "image-nano-banana-2-lite",
	expectedCredits: "5",
	idempotencyKey: "simulation-request-1",
	input: {
		kind: "text-to-image",
		prompt: "A ceramic vase",
		skuKey: "nano-banana-2-lite-1k",
		aspectRatio: "auto",
	},
});
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const currentDomain = {
	submitGeneration,
	submitGenerationForUser,
	createQuoteForUser,
	createGenerationForUser,
	createGenerationFromApprovedQuote,
	assertGenerationAllowed,
};
type Domain = typeof currentDomain;
const directory = resolve(process.cwd(), "../../.cache/generation-batch1");
const baselineDirectory = resolve(
	process.cwd(),
	"../../tooling/e2e/fixtures/generation-batch1/admission",
);
const baselineRuntimeDirectory = resolve(
	process.cwd(),
	".cache/generation-batch1/admission-baseline-runtime",
);
const domainSources = {
	"submit-generation.ts": "modules/media/procedures/submit-generation.ts",
	"create-quote.ts": "modules/media/procedures/create-quote.ts",
	"create-generation.ts": "modules/media/procedures/create-generation.ts",
	"generation-authorization.ts": "modules/media/lib/generation-authorization.ts",
};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Replay the saved timing-only source without changing the working checkout. */
async function loadTimingOnlyBaseline(): Promise<Domain> {
	const archivedHashes = JSON.parse(
		readFileSync(resolve(baselineDirectory, "admission-before.json.txt"), "utf8"),
	).sourceHashes as Record<string, string>;
	mkdirSync(baselineRuntimeDirectory, { recursive: true });
	const baselineTargets = new Map(
		Object.entries(domainSources).map(([file, path]) => [
			resolve(process.cwd(), path).slice(0, -3),
			resolve(baselineRuntimeDirectory, file),
		]),
	);
	for (const [file, originalPath] of Object.entries(domainSources)) {
		const saved = readFileSync(resolve(baselineDirectory, `${file}.txt`), "utf8");
		if (archivedHashes[file] && sha256(saved) !== archivedHashes[file])
			throw new Error(`BASELINE_SOURCE_HASH_MISMATCH:${file}`);
		const target = resolve(baselineRuntimeDirectory, file);
		// Only relative import locations are changed. Runtime operations stay byte-for-byte
		// identical to the archived source, including the former authorization reads.
		const rewritten = saved.replace(
			/(\bfrom\s*["'])(\.[^"']+)(["'])/g,
			(_match, before, specifier, after) => {
				const sourceTarget = resolve(dirname(resolve(process.cwd(), originalPath)), specifier);
				const relocated = baselineTargets.get(sourceTarget) ?? sourceTarget;
				const relativePath = relative(dirname(target), relocated).replaceAll("\\", "/");
				return `${before}${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}${after}`;
			},
		);
		writeFileSync(target, rewritten);
	}
	const [submit, quote, creation, authorization] = await Promise.all([
		import(
			/* @vite-ignore */ pathToFileURL(resolve(baselineRuntimeDirectory, "submit-generation.ts"))
				.href
		),
		import(
			/* @vite-ignore */ pathToFileURL(resolve(baselineRuntimeDirectory, "create-quote.ts")).href
		),
		import(
			/* @vite-ignore */ pathToFileURL(resolve(baselineRuntimeDirectory, "create-generation.ts"))
				.href
		),
		import(
			/* @vite-ignore */ pathToFileURL(
				resolve(baselineRuntimeDirectory, "generation-authorization.ts"),
			).href
		),
	]);
	return { ...submit, ...quote, ...creation, ...authorization } as Domain;
}

/** Serial delayed DB boundaries model the current one-connection request client, not SQL execution. */
function fixture(domain: Domain = currentDomain, providerResponseLoss = false) {
	const counts: Record<string, number> = {};
	let queue = Promise.resolve();
	const operation = (name: string, milliseconds = 8) => {
		counts[name] = (counts[name] ?? 0) + 1;
		queue = queue.then(() => sleep(milliseconds));
		return queue;
	};
	const quotes = new Map<string, any>();
	const jobs = new Map<string, any>();
	let claimed = false;
	let acceptedAt: number | undefined;
	let uncertain = false;
	const read = (name: string, value: unknown) => async () => {
		await operation(name);
		return value;
	};
	const database = {
		runtimeConfigOverride: {
			findMany: read("configRead", []),
			findFirst: read("runtimeFlagRead", null),
		},
		creditAccount: { findUnique: read("accountRead", { creditDebt: 0n }) },
		creditLot: { aggregate: read("balanceRead", { _sum: { remainingAmount: 100n } }) },
		generationQuote: {
			aggregate: read("budgetRead", { _sum: { costMicros: 0n } }),
			findFirst: async (input: { where: { id: string } }) => {
				await operation("quoteRead");
				return quotes.get(input.where.id) ?? null;
			},
		},
		storageUsageReservation: { aggregate: read("storageRead", { _sum: { bytes: 0n } }) },
	};
	const createQuoteDependencies: NonNullable<Parameters<typeof createQuoteForUser>[2]> = {
		now: () => new Date(),
		assertAllowed: domain.assertGenerationAllowed,
		getRouteGraphOptions: getCurrentExecutableRouteGraphOptions,
		createAdapter: () => ({
			provider: "waffo",
			adapter: {
				moderateText: async ({ ruleVersion }) => {
					counts.waffo = (counts.waffo ?? 0) + 1;
					await sleep(30);
					return { decision: "ALLOW", reasonCode: "NO_POLICY_MATCH", ruleVersion };
				},
			},
		}),
		persistApproved: async (quote) => {
			await operation("quoteTransaction", 16);
			if (quotes.has(quote.quoteId!)) throw { code: "P2002" };
			const saved = { ...quote, id: quote.quoteId!, costMicros: quote.costMicros ?? 0n, job: null };
			quotes.set(saved.id, saved);
			return saved;
		},
		recordDenied: vi.fn(),
	};
	const createJobDependencies: NonNullable<Parameters<typeof createGenerationForUser>[2]> = {
		now: () => new Date(),
		findQuote: async (_owner, id) => {
			await operation("quoteRead");
			return quotes.get(id) ?? null;
		},
		getRouteGraphOptions: getCurrentExecutableRouteGraphOptions,
		assertAllowed: domain.assertGenerationAllowed,
		loadEntitlement: loadUserPlanEntitlement,
		enforceRateLimit: enforceMediaRateLimit,
		createGenerationJob: async (request) => {
			await operation("jobTransaction", 24);
			const existing = jobs.get(request.quoteId);
			if (existing) return { job: existing, replayed: true };
			if (request.validateCurrentEligibility)
				await loadCurrentGenerationAdmission(
					{
						ownerId: request.ownerId,
						productKey: quotes.get(request.quoteId).productKey,
						costMicros: quotes.get(request.quoteId).costMicros,
						now: new Date(),
					},
					{
						runtimeConfigOverride: { findMany: read("transactionConfigRead", []) },
						subscription: { findMany: read("transactionEntitlementRead", []) },
						billingPeriod: { fields: { paidAmount: "paidAmount" } },
					} as never,
				);
			const job = {
				id: `job-${jobs.size + 1}`,
				status: "RESERVED",
				version: 0,
				creditsReserved: 5n,
				idempotencyKey: request.idempotencyKey,
			};
			jobs.set(request.quoteId, job);
			quotes.get(request.quoteId).job = job;
			counts.reservation = (counts.reservation ?? 0) + 1;
			return { job, replayed: false };
		},
	};
	const dependencies: NonNullable<Parameters<typeof submitGenerationForUser>[2]> = {
		findQuote: async (_owner, id) => {
			await operation("submissionLookup");
			return quotes.get(id) ?? null;
		},
		createQuote: (owner, input, _dependencies, submission, timing) =>
			domain.createQuoteForUser(owner, input, createQuoteDependencies, submission, timing),
		createJob: (owner, input, _dependencies, timing) =>
			domain.createGenerationForUser(owner, input, createJobDependencies, timing),
		createPreparedJob: (owner, input, admission, _dependencies, timing) =>
			domain.createGenerationFromApprovedQuote(
				owner,
				input,
				admission,
				createJobDependencies,
				timing,
			),
		dispatch: async (created) => {
			await dispatchGeneration(
				{ jobId: created.job.id, version: created.job.version },
				{
					isGenerationEnabled: () => true,
					store: {
						claimDispatch: async () => {
							await operation("dispatchClaim");
							if (claimed) return null;
							claimed = true;
							counts.attempt = (counts.attempt ?? 0) + 1;
							return {
								attemptId: "attempt-1",
								provider: "kie",
								providerModelId: "nano-banana-2",
								mediaKind: "image",
								queueKey: "kie",
								input: INPUT.input,
							};
						},
						recordSubmissionStarted: () => operation("submissionStarted"),
						recordSubmission: () => operation("submissionRecorded"),
						recordUncertainSubmission: async () => {
							uncertain = true;
							await operation("uncertaintyRecorded");
						},
					} as never,
					getProvider: () =>
						({
							submit: async () => {
								counts.kie = (counts.kie ?? 0) + 1;
								await sleep(25);
								acceptedAt ??= performance.now();
								if (providerResponseLoss) throw new Error("simulated accepted response loss");
								return {
									outcome: "accepted",
									providerTaskId: "kie-task-1",
									status: "RUNNING",
									reconciliation: {},
									idempotency: { providerSupported: false },
								};
							},
						}) as never,
				},
			);
		},
	};
	return {
		counts,
		operation,
		database,
		dependencies,
		createJobDependencies,
		createQuoteDependencies,
		get acceptedAt() {
			return acceptedAt;
		},
		get uncertain() {
			return uncertain;
		},
	};
}

type StageTiming = { requestId: string; stage: string; stageMs: number };
type Sample = {
	variant: "before" | "after";
	scenario: "normal" | "response-loss" | "concurrent-replay";
	sample: number;
	clickToKieAcceptanceMs: number;
	clickToDomainReturnMs: number;
	clickToAllDomainReturnsMs: number;
	individualDomainReturnsMs: number[];
	stageTimings: StageTiming[];
	operationsIncludingReplay: Record<string, number>;
};

function summarize(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		observations: sorted.length,
		medianMs:
			sorted.length % 2
				? sorted[Math.floor(sorted.length / 2)]!
				: (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2,
		minimumMs: sorted[0]!,
		maximumMs: sorted[sorted.length - 1]!,
	};
}

function writeVerifiedEvidence(variant: Sample["variant"], samples: Sample[]) {
	mkdirSync(directory, { recursive: true });
	const summaries = ["normal", "response-loss", "concurrent-replay"].map((scenario) => {
		const runs = samples.filter((sample) => sample.scenario === scenario);
		const stages = runs.flatMap((sample) => sample.stageTimings);
		return {
			scenario,
			sampleCount: runs.length,
			clickToDomainReturnMs: summarize(runs.map((run) => run.clickToDomainReturnMs)),
			clickToAllDomainReturnsMs: summarize(runs.map((run) => run.clickToAllDomainReturnsMs)),
			clickToKieAcceptanceMs: summarize(runs.map((run) => run.clickToKieAcceptanceMs)),
			stagePerCallMs: Object.fromEntries(
				[...new Set(stages.map((entry) => entry.stage))].map((stage) => [
					stage,
					summarize(stages.filter((entry) => entry.stage === stage).map((entry) => entry.stageMs)),
				]),
			),
			operationsIncludingReplay: runs.map((run) => run.operationsIncludingReplay),
		};
	});
	const sourceHashes = Object.fromEntries(
		Object.entries(domainSources).map(([file, path]) => [
			path,
			sha256(
				readFileSync(
					variant === "before"
						? resolve(baselineDirectory, `${file}.txt`)
						: resolve(process.cwd(), path),
				),
			),
		]),
	);
	writeFileSync(
		resolve(directory, `admission-${variant}-verified.json`),
		JSON.stringify(
			{
				variant,
				generatedAt: new Date().toISOString(),
				sampleCount: samples.length,
				kind: "fixed-delay isolated admission domain and dispatchGeneration simulator; not HTTP or production",
				source:
					variant === "before"
						? "archived timing-only source; procedure hashes checked against admission-before.json, authorization snapshot hash recorded here; only import paths relocated"
						: "current working-tree domain functions",
				sourceHashes,
				harnessSha256: sha256(
					readFileSync(
						resolve(process.cwd(), "modules/media/procedures/admission-simulation.test.ts"),
					),
				),
				conditions: {
					process:
						"modules already loaded; no cold Worker measurement; no explicit paid-work warm-up",
					fixtures: "new in-memory data and counters each run",
					execution:
						"three samples per scenario; before/after interleaved; one serialized delayed DB boundary queue; two simultaneous same-key callers only in concurrent scenario",
					clocks:
						"performance.now in one process; nested/overlapping stage durations are never summed",
					dispatch:
						"the injected dispatch invokes real dispatchGeneration inline, so domain return includes that simulated dispatch; production Workflow HTTP acceptance timing is not modeled",
				},
				delaysMs: {
					serialDatabaseBoundary: 8,
					quoteTransactionBoundary: 16,
					jobTransactionBoundary: 24,
					waffoSubmission: 30,
					kieSubmissionAcceptance: 25,
					kieAsynchronousCompletion: null,
				},
				metricDefinitions: {
					clickToDomainReturnMs:
						"harness start to first completed submitGenerationForUser return; real domain boundary, not HTTP network response",
					clickToAllDomainReturnsMs:
						"harness start to all concurrent same-key domain calls returning",
					clickToKieAcceptanceMs:
						"harness start to mock provider accepting inside actual dispatchGeneration handler",
					stagePerCallMs:
						"observed durations emitted by existing media.flow.timing; includes boundary queues and timer jitter, not server SQL execution",
				},
				unmeasured: [
					"real HTTP admission time and transport",
					"authentication middleware",
					"first rate-limit call in isolation (included in eligibility)",
					"transaction-internal server SQL execution and unexpanded SQL counts",
					"connection acquisition",
					"Cloudflare scheduling",
					"Kie asynchronous completion",
					"SeeAPI and browser (separate harnesses)",
					"preview signing (separate status harness)",
					"production latency",
				],
				production: "未做生产复测",
				summaries,
				samples,
			},
			null,
			2,
		),
	);
}

describe("fixed-delay admission simulation", () => {
	it("measures actual domain return and simulated Kie acceptance separately with replay", async () => {
		const verified = process.env.GENERATION_ADMISSION_SNAPSHOT === "verified";
		const baseline = verified ? await loadTimingOnlyBaseline() : undefined;
		vi.stubEnv("MEDIA_ENABLED_PROVIDERS", "kie");
		vi.stubGlobal("fetch", () => {
			throw new Error("NETWORK_FORBIDDEN_IN_ADMISSION_SIMULATION");
		});
		const samples: Sample[] = [];
		try {
			for (const scenario of ["normal", "response-loss", "concurrent-replay"] as const) {
				for (let sample = 1; sample <= (verified ? 3 : 1); sample++) {
					for (const variant of (verified ? ["before", "after"] : ["after"]) as Array<
						Sample["variant"]
					>) {
						const domain = variant === "before" ? baseline! : currentDomain;
						const f = fixture(domain, scenario === "response-loss");
						harness.active = f;
						vi.mocked(logger.info).mockClear();
						const requestIds = Array.from(
							{ length: scenario === "concurrent-replay" ? 2 : 1 },
							(_, index) => `sample-${variant}-${scenario}-${sample}-${index}`,
						);
						const individualDomainReturnsMs: number[] = [];
						const start = performance.now();
						const results = await Promise.all(
							requestIds.map(async (requestId) => {
								const result = await domain.submitGenerationForUser(
									"owner",
									INPUT,
									f.dependencies,
									createFlowTiming({ requestId }),
								);
								individualDomainReturnsMs.push(performance.now() - start);
								return result;
							}),
						);
						const stageTimings = vi.mocked(logger.info).mock.calls.flatMap(([message, details]) => {
							if (
								message !== "media.flow.timing" ||
								!details ||
								!requestIds.includes(details.requestId as string)
							)
								return [];
							return [
								{
									requestId: details.requestId as string,
									stage: details.stage as string,
									stageMs: details.stageMs as number,
								},
							];
						});
						const replay = await domain.submitGenerationForUser("owner", INPUT, f.dependencies);
						expect(replay.replayed).toBe(true);
						expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
						expect(f.counts.reservation).toBe(1);
						expect(f.counts.kie).toBe(1);
						expect(f.counts.attempt).toBe(1);
						expect(f.uncertain).toBe(scenario === "response-loss");
						expect(stageTimings.some((entry) => entry.stage === "admission.waffo")).toBe(true);
						if (scenario === "normal") {
							expect(f.counts.configRead).toBe(variant === "after" ? 1 : 2);
							expect(f.counts.accountRead).toBe(variant === "after" ? 1 : 2);
							expect(f.counts.entitlement).toBe(variant === "after" ? 1 : 3);
							expect(f.counts.runtimeFlagRead ?? 0).toBe(variant === "after" ? 0 : 4);
							expect(f.counts.quoteRead ?? 0).toBe(variant === "after" ? 0 : 1);
							expect(f.counts.rateLimit).toBe(2);
							expect(f.counts.transactionEntitlementRead ?? 0).toBe(variant === "after" ? 1 : 0);
						}
						samples.push({
							variant,
							scenario,
							sample,
							clickToKieAcceptanceMs: f.acceptedAt! - start,
							clickToDomainReturnMs: Math.min(...individualDomainReturnsMs),
							clickToAllDomainReturnsMs: Math.max(...individualDomainReturnsMs),
							individualDomainReturnsMs,
							stageTimings,
							operationsIncludingReplay: f.counts,
						});
					}
				}
			}
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
		if (verified) {
			writeVerifiedEvidence(
				"before",
				samples.filter((sample) => sample.variant === "before"),
			);
			writeVerifiedEvidence(
				"after",
				samples.filter((sample) => sample.variant === "after"),
			);
		}
	}, 30_000);

	it("measures the real protected procedure through RPC Fetch encoding without a network", async () => {
		const verified = process.env.GENERATION_ADMISSION_SNAPSHOT === "verified";
		const baseline = verified ? await loadTimingOnlyBaseline() : undefined;
		vi.stubEnv("MEDIA_ENABLED_PROVIDERS", "kie");
		vi.stubGlobal("fetch", () => {
			throw new Error("NETWORK_FORBIDDEN_IN_ADMISSION_SIMULATION");
		});
		const samples: HttpSample[] = [];
		try {
			for (const scenario of ["normal", "response-loss", "concurrent-replay"] as const) {
				for (let sample = 1; sample <= (verified ? 3 : 1); sample++) {
					for (const variant of (verified ? ["before", "after"] : ["after"]) as Array<
						Sample["variant"]
					>) {
						const domain = variant === "before" ? baseline! : currentDomain;
						const f = fixture(domain, scenario === "response-loss");
						harness.active = f;
						vi.mocked(logger.info).mockClear();
						const procedureReturns: number[] = [];
						const responseReady: number[] = [];
						const httpReturns: number[] = [];
						const procedure = domain.submitGeneration.use(async ({ next }) => {
							const result = await next();
							procedureReturns.push(performance.now());
							return result;
						});
						const handler = new RPCHandler({ media: { submitGeneration: procedure } });
						const requestIds = Array.from(
							{ length: scenario === "concurrent-replay" ? 2 : 1 },
							(_, index) => `http-${variant}-${scenario}-${sample}-${index}`,
						);
						const call = async (requestId: string) => {
							const client = createORPCClient<
								RouterClient<{ media: { submitGeneration: typeof procedure } }>
							>(
								new RPCLink({
									url: "http://loopback.invalid/api/rpc",
									headers: { "x-request-id": requestId },
									fetch: async (request) => {
										const handled = await handler.handle(request, {
											prefix: "/api/rpc",
											context: {
												headers: request.headers,
												requestId,
												responseHeaders: new Headers(),
											},
										});
										if (!handled.response) throw new Error("RPC_ROUTE_NOT_FOUND");
										responseReady.push(performance.now());
										return handled.response;
									},
								}),
							);
							const result = await client.media.submitGeneration(INPUT);
							httpReturns.push(performance.now());
							return result;
						};
						const start = performance.now();
						const results = await Promise.all(requestIds.map(call));
						const stageTimings = vi.mocked(logger.info).mock.calls.flatMap(([message, details]) => {
							if (
								message !== "media.flow.timing" ||
								!details ||
								!requestIds.includes(details.requestId as string)
							)
								return [];
							return [
								{
									requestId: details.requestId as string,
									stage: details.stage as string,
									stageMs: details.stageMs as number,
								},
							];
						});
						const endpointTimes = {
							clickToProcedureReturnMs: Math.min(...procedureReturns) - start,
							clickToRpcResponseReadyMs: Math.min(...responseReady) - start,
							clickToHttpResponseDecodedMs: Math.min(...httpReturns) - start,
							clickToAllHttpResponsesDecodedMs: Math.max(...httpReturns) - start,
							clickToKieAcceptanceMs: f.acceptedAt! - start,
						};
						const replay = await call(`http-${variant}-${scenario}-${sample}-replay`);
						expect(replay.replayed).toBe(true);
						expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
						expect(f.counts.reservation).toBe(1);
						expect(f.counts.kie).toBe(1);
						expect(f.counts.attempt).toBe(1);
						expect(f.uncertain).toBe(scenario === "response-loss");
						expect(f.counts.identity).toBe(requestIds.length + 1);
						expect(stageTimings.some((entry) => entry.stage === "request.identity")).toBe(true);
						expect(endpointTimes.clickToHttpResponseDecodedMs).toBeGreaterThanOrEqual(
							endpointTimes.clickToProcedureReturnMs,
						);
						if (scenario === "normal") {
							expect(f.counts.configRead).toBe(variant === "after" ? 1 : 2);
							expect(f.counts.accountRead).toBe(variant === "after" ? 1 : 2);
							expect(f.counts.entitlement).toBe(variant === "after" ? 1 : 3);
							expect(f.counts.runtimeFlagRead ?? 0).toBe(variant === "after" ? 0 : 4);
							expect(f.counts.quoteRead ?? 0).toBe(variant === "after" ? 0 : 1);
							expect(f.counts.rateLimit).toBe(2);
						}
						samples.push({
							variant,
							scenario,
							sample,
							...endpointTimes,
							stageTimings,
							operationsIncludingReplay: f.counts,
						});
					}
				}
			}
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
		if (verified)
			for (const variant of ["before", "after"] as const)
				writeHttpEvidence(
					variant,
					samples.filter((sample) => sample.variant === variant),
				);
	}, 30_000);
});

type HttpSample = Omit<
	Sample,
	"clickToDomainReturnMs" | "clickToAllDomainReturnsMs" | "individualDomainReturnsMs"
> & {
	clickToProcedureReturnMs: number;
	clickToRpcResponseReadyMs: number;
	clickToHttpResponseDecodedMs: number;
	clickToAllHttpResponsesDecodedMs: number;
};

function writeHttpEvidence(variant: Sample["variant"], samples: HttpSample[]) {
	mkdirSync(directory, { recursive: true });
	const summaries = ["normal", "response-loss", "concurrent-replay"].map((scenario) => {
		const runs = samples.filter((sample) => sample.scenario === scenario);
		const stages = runs.flatMap((sample) => sample.stageTimings);
		return {
			scenario,
			sampleCount: runs.length,
			...Object.fromEntries(
				(
					[
						"clickToProcedureReturnMs",
						"clickToRpcResponseReadyMs",
						"clickToHttpResponseDecodedMs",
						"clickToAllHttpResponsesDecodedMs",
						"clickToKieAcceptanceMs",
					] as const
				).map((metric) => [metric, summarize(runs.map((run) => run[metric]))]),
			),
			stagePerCallMs: Object.fromEntries(
				[...new Set(stages.map((entry) => entry.stage))].map((stage) => [
					stage,
					summarize(stages.filter((entry) => entry.stage === stage).map((entry) => entry.stageMs)),
				]),
			),
			operationsIncludingReplay: runs.map((run) => run.operationsIncludingReplay),
		};
	});
	writeFileSync(
		resolve(directory, `admission-http-${variant}-verified.json`),
		JSON.stringify(
			{
				variant,
				generatedAt: new Date().toISOString(),
				sampleCount: samples.length,
				kind: "actual protected submitGeneration procedure and RPCHandler/RPCLink Fetch boundary; no socket or external network",
				harnessSha256: sha256(
					readFileSync(
						resolve(process.cwd(), "modules/media/procedures/admission-simulation.test.ts"),
					),
				),
				sourceHashes: Object.fromEntries(
					Object.entries(domainSources).map(([file, path]) => [
						path,
						sha256(
							readFileSync(
								variant === "before"
									? resolve(baselineDirectory, `${file}.txt`)
									: resolve(process.cwd(), path),
							),
						),
					]),
				),
				conditions: {
					process:
						"loaded modules; fresh fixture per run; three paired samples per scenario, before/after interleaved; not cold Workers or production",
					load: "one serialized boundary queue, two same-key calls only for concurrent-replay",
					delaysMs: {
						databaseBoundary: 8,
						identityBoundary: 8,
						dispatchRouteBoundary: 8,
						quoteTransaction: 16,
						jobTransaction: 24,
						waffoSubmission: 30,
						kieSubmissionAcceptance: 25,
						kieAsynchronousCompletion: null,
					},
					dispatch:
						"production dispatchCreatedGeneration and dispatchCreatedJobBestEffort call mocked route/dispatch adapters; adapter executes real dispatchGeneration inline",
				},
				metricDefinitions: {
					clickToProcedureReturnMs:
						"RPC client start to real protected procedure handler returning, before RPC response encoding; not the separately measured bare domain function return",
					clickToRpcResponseReadyMs: "RPC client start to RPCHandler producing a Fetch Response",
					clickToHttpResponseDecodedMs:
						"RPC client start to RPCLink decoding that Fetch Response; local HTTP semantics without sockets/Hono/Cloudflare/network",
					clickToAllHttpResponsesDecodedMs:
						"RPC client start to all simultaneous callers decoding their responses",
					clickToKieAcceptanceMs:
						"RPC client start to mock Kie accepting inside real dispatchGeneration",
				},
				unmeasured: [
					"Hono middleware and actual network transport",
					"real auth/database latency",
					"SQL server execution",
					"connection acquisition",
					"Cloudflare scheduling",
					"Kie asynchronous completion",
					"SeeAPI/signing/browser (separate harnesses)",
					"production latency",
				],
				production: "未做生产复测",
				summaries,
				samples,
			},
			null,
			2,
		),
	);
}
