/** Isolated LOCAL integration driver. Never imported by an app or deployment entry.
 * PostgreSQL, S3 and final Worker artifact are real. Only external supplier HTTP
 * responses (including their DNS/CDN) are fixtures. All other egress is rejected.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { createWriteStream, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { temporaryReferenceReviewPollingInterval } from "../../../apps/saas/modules/media/lib/temporary-reference-review";
import {
	loadScanlessBrowserModules,
	SCANLESS_JOB_EVENTS_MODULE,
	SCANLESS_NOTIFICATION_OBSERVATION_MODULE,
	SCANLESS_NOTIFICATION_OBSERVER_MODULE,
} from "./scanless-browser-modules";
import { summarizeConcurrentCases } from "./scanless-concurrency";
import { resolveScanlessDatabasePool } from "./scanless-database-pool";
import { withinScanlessDeadline } from "./scanless-deadline";
import { observeDatabaseTransactions } from "./scanless-error-evidence";
import { createScanlessImageModerationWake } from "./scanless-image-callback";
import { createScanlessOutputFixture, LEGACY_SCANLESS_PNG } from "./scanless-image-fixture";
import {
	createScanlessRequestDefer,
	resolveScanlessMeasurementModes,
	scanlessMeasurementTimeline,
} from "./scanless-measurement-modes";
import {
	hasScanlessCommittedReadyReceipt,
	SCANLESS_NOTIFICATION_OBSERVATION_MS,
} from "./scanless-notification-observation";
import { resolveScanlessSqlMetrics } from "./scanless-sql-metrics";
import {
	createScanlessSubscriptionNamespace,
	scanlessWebSocketClose,
	SCANLESS_DRIVER_WORKER,
} from "./scanless-subscription-bridge";
import {
	observeScanlessPreClickReview,
	scanlessUploadPreReviewErrors,
	type ScanlessPreClickReviewObservation,
	type ScanlessReferenceReviewStatus,
	type ScanlessUploadReviewMode,
} from "./scanless-upload-pre-review";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = path.join(root, "apps/workflows");
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const databasePool = resolveScanlessDatabasePool({
	databaseUrl,
	mode: process.env.SCANLESS_DATABASE_POOL_MODE,
	poolUrl: process.env.SCANLESS_DATABASE_POOL_URL,
});
const secret = "scanless-local-only-32-character-secret";
const origin = "http://127.0.0.1:9560";
const delay = Number(process.env.SCANLESS_REVIEW_DELAY_MS ?? 3500);
const promptReviewDelay = 100;
const generationDelay = Number(process.env.SCANLESS_KIE_DELAY_MS ?? 1500);
const generationResponseDelay = Number(process.env.SCANLESS_KIE_RESPONSE_DELAY_MS ?? 0);
assert(Number.isSafeInteger(generationDelay) && generationDelay >= 0 && generationDelay <= 15_000);
assert(
	Number.isSafeInteger(generationResponseDelay) &&
		generationResponseDelay >= 0 &&
		generationResponseDelay <= 5_000,
);
const label = process.env.SCANLESS_LABEL ?? "new-idle-delayed";
const concurrency = Number(process.env.SCANLESS_CONCURRENCY ?? 1);
assert(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 50);
const caseTimeoutMs = Number(
	process.env.SCANLESS_TIMEOUT_MS ?? (concurrency > 1 ? 180_000 : 90_000),
);
assert(Number.isSafeInteger(caseTimeoutMs) && caseTimeoutMs >= 5_000 && caseTimeoutMs <= 600_000);
const maintenanceBusy = process.env.SCANLESS_MAINTENANCE_BUSY === "true";
const imageCallbacks = process.env.SCANLESS_IMAGE_CALLBACKS === "true";
const storageFreshReadEnabled = process.env.SCANLESS_STORAGE_FRESH_READ === "true";
const loginBonusReadCommittedEnabled = process.env.SCANLESS_LOGIN_BONUS_READ_COMMITTED === "true";
const settlementFreshReadEnabled = process.env.SCANLESS_SETTLEMENT_FRESH_READ === "true";
const measurementModes = resolveScanlessMeasurementModes({
	admissionDispatchMode: process.env.SCANLESS_ADMISSION_DISPATCH_MODE,
	inputReviewMode: process.env.SCANLESS_INPUT_REVIEW_MODE,
});
const uploadReviewMode: ScanlessUploadReviewMode | null =
	measurementModes.inputReviewMode === "upload-reviewed" ||
	measurementModes.inputReviewMode === "upload-pending"
		? measurementModes.inputReviewMode
		: null;
const browserMode = process.env.SCANLESS_BROWSER_MODE ?? "polling";
assert(["polling", "notifications"].includes(browserMode), "INVALID_SCANLESS_BROWSER_MODE");
const sqlMetrics = resolveScanlessSqlMetrics({
	mode: process.env.SCANLESS_SQL_METRICS,
	format: process.env.EZPIC_LOCAL_SQL_METRICS_FORMAT,
});
const browserPollMs = Number(
	process.env.SCANLESS_BROWSER_POLL_MS ?? (uploadReviewMode ? 2000 : 250),
);
assert(Number.isSafeInteger(browserPollMs) && browserPollMs >= 25 && browserPollMs <= 30_000);
if (uploadReviewMode)
	assert.equal(browserPollMs, 2000, "REAL_UPLOAD_REQUIRES_ACTIVE_TWO_SECOND_POLL");
const preReviewPollMs = temporaryReferenceReviewPollingInterval({ enabled: true });
assert(typeof preReviewPollMs === "number");
const reviewSigningKey = "whsec_scanless_local_fixture_20261022";
const expectedSourceReads = process.env.SCANLESS_EXPECT_SOURCE_READS;
if (expectedSourceReads !== undefined) assert.match(expectedSourceReads, /^[1-3]$/);
const output = path.resolve(process.env.SCANLESS_ARTIFACT ?? path.join(app, "dist-workers"));
const evidenceDirectory = path.join(root, ".cache/first-image");
await mkdir(evidenceDirectory, { recursive: true });
const journal = createWriteStream(path.join(evidenceDirectory, `${label}.journal.jsonl`), {
	flags: "wx",
});
const harnessSourceFiles = [
	"tooling/e2e/src/scanless-runtime.mts",
	"tooling/e2e/src/scanless-database-pool.ts",
	"tooling/e2e/src/scanless-sql-metrics.ts",
	"tooling/e2e/src/scanless-measurement-modes.ts",
	"tooling/e2e/src/scanless-upload-pre-review.ts",
	"tooling/e2e/src/scanless-image-callback.ts",
	"tooling/e2e/src/scanless-subscription-bridge.ts",
	"tooling/e2e/src/scanless-browser-modules.ts",
	"tooling/e2e/src/scanless-browser-notifications.ts",
	"tooling/e2e/src/scanless-notification-observation.ts",
	"apps/saas/modules/media/lib/job-events.ts",
	"apps/saas/modules/media/lib/temporary-reference-review.ts",
	"packages/jobs/src/realtime/contracts.ts",
	"tooling/e2e/src/scanless-deadline.ts",
	"tooling/e2e/src/scanless-error-evidence.ts",
	"tooling/e2e/src/scanless-timing-evidence.ts",
	"tooling/e2e/src/scanless-concurrency.ts",
	"tooling/e2e/src/analyze-generation-budget.mts",
	"tooling/e2e/src/scanless-postgres-evidence.ts",
	"tooling/e2e/src/analyze-scanless-postgres.mts",
	".cache/generation-one-second-20261022/run-scanless.ps1",
	".cache/generation-one-second-20261022/stop-scanless-tree.ps1",
	".cache/generation-one-second-20261022/capture-scanless-processes.ps1",
	".cache/generation-one-second-20261022/run-scanless-v9.ps1",
	".cache/generation-one-second-20261022/stop-scanless-tree-v9.ps1",
	".cache/generation-one-second-20261022/capture-scanless-processes-v9.ps1",
	".cache/generation-one-second-20261022/v9-process-ownership.ps1",
];
const harnessSources = await Promise.all(
	harnessSourceFiles.map(async (file) => ({
		file,
		sha256: createHash("sha256")
			.update(await readFile(path.join(root, file)))
			.digest("hex"),
	})),
);
const browserModules = await loadScanlessBrowserModules();
let lifecyclePhase = "setup";
const env = {
	RESEND_API_KEY: "re_isolated_fixture",
	NODE_ENV: "production",
	DATABASE_URL: databaseUrl,
	...sqlMetrics.env,
	BETTER_AUTH_SECRET: secret,
	NEXT_PUBLIC_SAAS_URL: origin,
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_JOB_EVENTS_ENABLED: "true",
	MEDIA_STORAGE_FRESH_READ_ENABLED: String(storageFreshReadEnabled),
	MEDIA_LOGIN_BONUS_READ_COMMITTED_ENABLED: String(loginBonusReadCommittedEnabled),
	MEDIA_SETTLEMENT_FRESH_READ_ENABLED: String(settlementFreshReadEnabled),
	MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
	MEDIA_RECOVERY_PROVIDERS: "kie",
	KIE_API_KEY: "isolated-fixture",
	SEEAPI_API_KEY: "isolated-fixture",
	SEEAPI_WEBHOOK_SIGNING_KEYS: imageCallbacks
		? JSON.stringify({ whkey_scanless: reviewSigningKey })
		: "",
	MEDIA_SAFETY_ADAPTER: "configured",
	MODERATION_TEXT_WAFFO_ENABLED: "true",
	MODERATION_TEXT_SIGHTENGINE_ENABLED: "false",
	MODERATION_IMAGE_SEEAPI_ENABLED: "true",
	MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
	S3_ENDPOINT: "http://127.0.0.1:9540",
	S3_REGION: "us-east-1",
	S3_ACCESS_KEY_ID: "scanless",
	S3_SECRET_ACCESS_KEY: "scanless-local-only",
	MEDIA_BUCKET_NAME: "scanless-private",
	WORKFLOWS_DISPATCH_URL: "http://127.0.0.1:9561/internal/dispatch",
	WORKFLOWS_DISPATCH_SECRET: secret,
	WAFFO_MERCHANT_ID: "MER_0000000000000000000000",
	WAFFO_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ type: "pkcs8", format: "pem" })
		.toString(),
};
Object.assign(process.env, env);
// The application URL must be HTTPS in production; the private loopback dispatcher
// is used by this local driver only. Keep the Worker itself in production mode.
process.env.NODE_ENV = "test";
const nativeFetch = globalThis.fetch;
const observations: Array<Record<string, unknown>> = [];
const identityCases = new Map<string, number>();
const enrolledCases = new Map<number, { ownerId: string; inputAssetId?: string; jobId?: string }>();
function caseFromUrl(value: string): number | undefined {
	for (const part of new URL(value).pathname.split("/")) {
		const caseIndex = identityCases.get(decodeURIComponent(part).replace(/\.png$/, ""));
		if (caseIndex !== undefined) return caseIndex;
	}
	return undefined;
}
const mark = (stage: string, data: Record<string, unknown> = {}) => {
	const ids = [data.jobId, data.assetId, data.id, data.ownerId, data.requestId];
	const caseIndex =
		typeof data.caseIndex === "number"
			? data.caseIndex
			: ids
					.map((id) => (typeof id === "string" ? identityCases.get(id) : undefined))
					.find((index) => index !== undefined);
	if (caseIndex !== undefined)
		for (const id of ids) if (typeof id === "string") identityCases.set(id, caseIndex);
	const observation = { stage, at: Date.now(), caseIndex, ...data };
	observations.push(observation);
	if (
		[
			"preparation.upload.started",
			"preparation.upload.returned",
			"preparation.review.observed",
			"click",
			"admission.returned",
			"admission.transaction.failure",
			"browser.visible",
			"browser.failed",
			"case.timeout",
			"lifecycle",
		].includes(stage)
	)
		journal.write(JSON.stringify(observation) + "\n");
};
const reviews = new Map<string, { readyAt: number; role: string; caseIndex: number }>();
const generations = new Map<string, { readyAt: number; caseIndex: number }>();
const png = LEGACY_SCANLESS_PNG;
let callbackHandler: (request: Request) => Promise<Response>;
let imageCallbackHandler: (request: Request) => Promise<Response>;
const outputFixture = createScanlessOutputFixture({
	profile: process.env.SCANLESS_OUTPUT_PROFILE,
	legacyBytes: process.env.SCANLESS_OUTPUT_BYTES,
});
const outputPng = outputFixture.bytes;
const outputBytes = outputPng.length;
let occupyMaintenance: () => Promise<void> = async () => undefined;
const timers = new Set<ReturnType<typeof setTimeout>>();
const pending = new Set<Promise<void>>();
const backgroundErrors: unknown[] = [];
journal.on("error", (error) => backgroundErrors.push(error));
const stage = (phase: string) => {
	lifecyclePhase = phase;
	mark("lifecycle", { phase, pendingCount: pending.size, timerCount: timers.size });
	console.log(
		"SCANLESS_PHASE",
		JSON.stringify({ phase, at: Date.now(), pendingCount: pending.size }),
	);
};
function schedule(operation: () => Promise<void>, milliseconds: number) {
	const timer = setTimeout(() => {
		timers.delete(timer);
		const task = operation()
			.catch((error) => {
				backgroundErrors.push(error);
				console.error(error);
			})
			.finally(() => pending.delete(task));
		pending.add(task);
	}, milliseconds);
	timers.add(timer);
}
async function deliverReviewCallback(url: string, id: string, attempt = 1): Promise<void> {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const body = JSON.stringify({ event: "inference.completed", id });
	const signature = createHmac("sha256", reviewSigningKey)
		.update(`${timestamp}.${body}`)
		.digest("hex");
	const response = await imageCallbackHandler(
		new Request(url, {
			method: "POST",
			body,
			headers: {
				"X-SEEAPI-Timestamp": timestamp,
				"X-SEEAPI-Signing-Key": "whkey_scanless",
				"X-SEEAPI-Signature": `v1=${signature}`,
			},
		}),
	);
	mark("seeapi.callback.returned", { id, attempt, status: response.status });
	if (response.status === 503 && attempt < 20) {
		schedule(() => deliverReviewCallback(url, id, attempt + 1), 250);
		return;
	}
	assert.equal(response.status, 202, "IMAGE_CALLBACK_NOT_ACCEPTED");
}
async function supplier(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.hostname === "cloudflare-dns.com")
		return Response.json({
			Status: 0,
			Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [],
		});
	if (url.hostname === "tempfile.aiquickdraw.com") {
		const caseIndex = caseFromUrl(request.url);
		assert.notEqual(caseIndex, undefined, "UNATTRIBUTED_OUTPUT_DOWNLOAD");
		mark("supplier.output.download", { caseIndex, responseBytes: outputPng.length });
		return new Response(outputPng, {
			headers: { "Content-Type": "image/png", "Content-Length": String(outputPng.length) },
		});
	}
	if (url.hostname === "api.waffo.ai") {
		const body = await request.text();
		const caseIndex = Number(/fixture-case-(\d+)-end/.exec(body)?.[1]);
		assert(
			Number.isSafeInteger(caseIndex) && caseIndex >= 0 && caseIndex < concurrency,
			"UNATTRIBUTED_TEXT_REVIEW",
		);
		const requestId = randomUUID();
		const startedAt = Date.now();
		mark("waffo.start", {
			caseIndex,
			requestId,
			at: startedAt,
			plannedReadyAt: startedAt + promptReviewDelay,
			processingDelayMs: promptReviewDelay,
		});
		await new Promise((r) => setTimeout(r, promptReviewDelay));
		mark("waffo.end", { caseIndex, requestId });
		return Response.json({
			data: {
				action: "allow",
				reasonCode: "allowed",
				requestId: randomUUID(),
				semanticStatus: "scored",
				matchedCategories: [],
			},
		});
	}
	if (url.hostname === "api.seeapi.com") {
		assert.equal(request.headers.get("Authorization"), `Bearer ${env.SEEAPI_API_KEY}`);
		let id: string;
		if (request.method === "POST") {
			const requestStartedAt = Date.now();
			const body = (await request.json()) as {
				input: { image_url: string };
				callback_url?: string;
			};
			id = randomUUID();
			const role = body.input.image_url.includes("temporary") ? "input" : "output";
			const caseIndex = caseFromUrl(body.input.image_url);
			assert.notEqual(caseIndex, undefined, "UNATTRIBUTED_IMAGE_REVIEW");
			identityCases.set(id, caseIndex!);
			mark("seeapi.request", { id, role, at: requestStartedAt });
			// Assert that the review can really read the exact private S3 object.
			const asset = await nativeFetch(body.input.image_url);
			assert(asset.ok);
			const reviewedBytes = Buffer.from(await asset.arrayBuffer());
			assert.deepEqual(reviewedBytes, role === "input" ? png : outputPng);
			mark("supplier.review.asset_download", { id, role, responseBytes: reviewedBytes.length });
			const acceptedAt = Date.now();
			reviews.set(id, { role, caseIndex: caseIndex!, readyAt: acceptedAt + delay });
			mark("seeapi.submit", {
				id,
				role,
				at: acceptedAt,
				readyAt: reviews.get(id)!.readyAt,
				processingDelayMs: delay,
			});
			if (imageCallbacks) {
				assert(body.callback_url, "IMAGE_CALLBACK_URL_MISSING");
				const callbackUrl = body.callback_url;
				schedule(() => deliverReviewCallback(callbackUrl, id), delay);
			} else assert.equal(body.callback_url, undefined);
		} else id = url.pathname.split("/").at(-1)!;
		const task = reviews.get(id)!;
		assert(task);
		const done = Date.now() >= task.readyAt;
		if (request.method !== "POST")
			mark("seeapi.query", { id, role: task.role, done, readyAt: task.readyAt });
		return Response.json({
			id,
			object: "inference",
			model: "nsfw-filter",
			endpoint: "image-moderation",
			provider: "seeapi",
			status: done ? "succeeded" : "processing",
			error: null,
			result: done
				? { type: "json", data: { flagged: false, categories: { nsfw: [], special_care: [] } } }
				: null,
		});
	}
	if (url.hostname === "api.kie.ai") {
		if (request.method === "POST") {
			const body = (await request.json()) as {
				callBackUrl?: string;
				input?: { image_urls?: string[] };
			};
			const caseIndex = body.input?.image_urls?.length
				? caseFromUrl(body.input.image_urls[0]!)
				: undefined;
			assert.notEqual(caseIndex, undefined, "UNATTRIBUTED_MODEL_SUBMISSION");
			for (const imageUrl of body.input?.image_urls ?? []) {
				const asset = await nativeFetch(imageUrl);
				assert(asset.ok);
				assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
				mark("supplier.generation.asset_download", { caseIndex, responseBytes: png.length });
			}
			const id = randomUUID();
			identityCases.set(id, caseIndex!);
			const acceptedAt = Date.now();
			const readyAt = acceptedAt + generationDelay;
			generations.set(id, { readyAt, caseIndex: caseIndex! });
			mark("kie.accepted", { id, at: acceptedAt, readyAt, processingDelayMs: generationDelay });
			if (maintenanceBusy) schedule(occupyMaintenance, 1200);
			if (body.callBackUrl) {
				schedule(
					async () => {
						mark("kie.completed", { id });
						const response = await callbackHandler(
							new Request(body.callBackUrl!, {
								method: "POST",
								body: JSON.stringify({ data: { taskId: id } }),
							}),
						);
						mark("kie.callback.returned", { id, status: response.status });
					},
					Math.max(0, readyAt - Date.now()),
				);
			}
			if (generationResponseDelay > 0) {
				const startedAt = Date.now();
				await new Promise((resolve) => setTimeout(resolve, generationResponseDelay));
				mark("kie.fixture.response_delay", { id, startedAt, completedAt: Date.now() });
			}
			mark("kie.submit.responded", { id });
			return Response.json({ code: 200, data: { taskId: id } });
		}
		const id = url.searchParams.get("taskId")!;
		const task = generations.get(id)!;
		assert(task);
		const done = Date.now() >= task.readyAt;
		mark("kie.query", { id, done });
		return Response.json({
			code: 200,
			data: {
				taskId: id,
				state: done ? "success" : "waiting",
				resultJson: done
					? JSON.stringify({ resultUrls: [`https://tempfile.aiquickdraw.com/scanless/${id}.png`] })
					: null,
			},
		});
	}
	throw new Error(`UNAPPROVED_EGRESS:${url.hostname}`);
}
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	if (url.hostname === "127.0.0.1" && ["9540", "9560", "9561"].includes(url.port))
		return nativeFetch(request);
	return supplier(request);
};
const cleanup: Array<() => void | Promise<void>> = [];
const closeConnections: Array<() => void> = [];
let server: ReturnType<typeof createServer> | undefined;
let browser:
	| {
			close(): Promise<void>;
			newContext(): Promise<{
				newPage(): Promise<{
					goto(url: string): Promise<unknown>;
					click(selector: string): Promise<void>;
					evaluate<Input, Output>(
						operation: (input: Input) => Output | Promise<Output>,
						input: Input,
					): Promise<Output>;
				}>;
			}>;
	  }
	| undefined;
try {
	const wr = createRequire(realpathSync(path.join(app, "node_modules/wrangler/package.json")));
	const { Miniflare, convertV4MiniflareOptions } = wr("miniflare");
	const wasm = (await readdir(output)).filter((f) => f.endsWith(".wasm"));
	const runtime = new Miniflare(
		convertV4MiniflareOptions({
			host: "127.0.0.1",
			port: 9561,
			workers: [
				{
					name: "driver",
					compatibilityDate: "2026-09-10",
					modules: true,
					script: SCANLESS_DRIVER_WORKER,
					durableObjects: {
						EXECUTOR: { className: "WorkerJobs", scriptName: "jobs", useSQLite: true },
						MEDIA_JOB_EVENTS: { className: "MediaJobEvents", scriptName: "jobs", useSQLite: true },
					},
					serviceBindings: { ENTRY: "jobs" },
				},
				{
					name: "jobs",
					compatibilityDate: "2026-09-10",
					compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
					modulesRoot: output,
					modules: [
						{ type: "ESModule", path: path.join(output, "workers.js") },
						...wasm.map((f) => ({ type: "CompiledWasm", path: path.join(output, f) })),
					],
					durableObjects: {
						JOBS_EXECUTOR: { className: "WorkerJobs", useSQLite: true },
						MEDIA_JOB_EVENTS: { className: "MediaJobEvents", useSQLite: true },
					},
					serviceBindings: {
						JOBS_CONTROL: { name: "jobs", entrypoint: "ControlExecutor" },
						JOBS_TRANSFER: { name: "jobs", entrypoint: "TransferExecutor" },
					},
					workflows: { JOBS: { name: "isolated-scanless-jobs", className: "JobsWorkflow" } },
					hyperdrives: { HYPERDRIVE: databasePool.hyperdriveUrl },
					bindings: {
						...env,
						NEXT_PUBLIC_SAAS_URL: "https://isolated.invalid",
						WORKFLOWS_DISPATCH_URL: "https://isolated.invalid/internal/dispatch",
						EZPIC_RUNTIME: "workers",
						EZPIC_DATABASE_BINDING: "hyperdrive",
					},
					outboundService: async (request: Request) => {
						const url = new URL(request.url);
						if (url.hostname === "127.0.0.1" && url.port === "9540") {
							try {
								const startedAt = Date.now();
								let requestBodyBytes = 0;
								const reader = request.body?.getReader();
								const requestBody = reader
									? new ReadableStream<Uint8Array>({
											async pull(controller) {
												try {
													const part = await reader.read();
													if (part.done) controller.close();
													else {
														requestBodyBytes += part.value.byteLength;
														controller.enqueue(part.value);
													}
												} catch (error) {
													controller.error(error);
												}
											},
											cancel(reason) {
												return reader.cancel(reason);
											},
										})
									: undefined;
								const response = await nativeFetch(request.url, {
									method: request.method,
									headers: Object.fromEntries(request.headers),
									...(requestBody ? { body: requestBody, duplex: "half" } : {}),
								} as RequestInit & { duplex?: "half" });
								mark("storage.http", {
									caseIndex: caseFromUrl(request.url),
									method: request.method,
									path: url.pathname,
									status: response.status,
									startedAt,
									headersAt: Date.now(),
									// This span includes the streaming bridge and server work.
									// It is not a measurement of unavoidable storage/network time.
									responseContentLength: response.headers.get("content-length"),
									requestBodyBytes,
								});
								return response;
							} catch (e) {
								console.error("local-storage-error", String(e));
								throw e;
							}
						}
						return supplier(request);
					},
				},
			],
		}),
	);
	cleanup.push(() => runtime.dispose());
	const { db, getDatabaseClient, runWithDatabaseClient } = await import("@repo/database/client");
	cleanup.push(() => db.$disconnect());
	const sharedNodeDatabase = getDatabaseClient();
	function admissionDatabase(caseIndex: number) {
		return observeDatabaseTransactions(sharedNodeDatabase, (failure) => {
			mark("admission.transaction.failure", { caseIndex, ...failure });
		});
	}
	const { logger } = await import("../../../packages/logs/index");
	const logInfo = logger.info.bind(logger);
	logger.info = ((message: unknown, details: Record<string, unknown>) => {
		if (message === "media.flow.timing") mark("flow.timing", details);
		else logInfo(message, details);
	}) as typeof logger.info;
	cleanup.push(() => {
		logger.info = logInfo;
	});
	const database = await import("@repo/database");
	const storage = await import("@repo/storage");
	const { temporaryReferenceObjectKey } = await import("@repo/config");
	const { signTemporaryReference, verifyTemporaryReference } =
		await import("../../../packages/api/modules/media/lib/temporary-reference-token");
	const { submitGeneration } =
		await import("../../../packages/api/modules/media/procedures/submit-generation");
	const { temporaryReferenceVerificationProfile, uploadTemporaryReference } =
		await import("../../../packages/api/modules/media/temporary-reference-upload");
	const { getTemporaryReferenceStatus } =
		await import("../../../packages/api/modules/media/procedures/get-temporary-reference-status");
	const { getJob } = await import("../../../packages/api/modules/media/procedures/get-job");
	const { serveMediaJobEvents } = await import("../../../packages/api/modules/media/job-events");
	const { runWithMediaJobEvents } = await import("@repo/jobs/realtime/context");
	const { call } = createRequire(path.join(root, "packages/api/package.json"))("@orpc/server");
	const { createKieCallbackHandler } =
		await import("../../../packages/api/modules/media/webhooks/kie-callback");
	callbackHandler = createKieCallbackHandler();
	const { createImageModerationCallbackHandler } =
		await import("../../../packages/api/modules/media/webhooks/image-moderation-callback");
	const { wakeJob, dispatchJob } = await import("@repo/jobs/orchestration/client");
	imageCallbackHandler = createImageModerationCallbackHandler({
		environment: () => ({ ...env, NEXT_PUBLIC_SAAS_URL: "https://isolated.invalid" }),
		wake: createScanlessImageModerationWake(database, db),
		dispatch: wakeJob,
	});
	const { S3Client, CreateBucketCommand, ListObjectsV2Command } = createRequire(
		path.join(root, "packages/storage/package.json"),
	)("@aws-sdk/client-s3");
	const s3 = new S3Client({
		endpoint: env.S3_ENDPOINT,
		region: env.S3_REGION,
		forcePathStyle: true,
		credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
	});
	cleanup.push(() => s3.destroy());
	await runtime.ready;
	await s3
		.send(new CreateBucketCommand({ Bucket: env.MEDIA_BUCKET_NAME }))
		.catch((e: { name: string }) => {
			if (!e.name.includes("BucketAlready")) throw e;
		});
	if (maintenanceBusy) {
		// Real unrelated maintenance work waits on one deliberately held PostgreSQL row.
		// No scheduler sleeps/results or global tables are mocked or locked.
		const quote = await db.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId: "contention-fixture",
				submittedByUserId: "contention-fixture",
				productKey: "image-nano-banana-2-lite",
				catalogVersion: "fixture",
				pricingVersion: "fixture",
				credits: 1n,
				costMicros: 1n,
				inputSnapshot: {},
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 86400000),
			},
		});
		const job = await db.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: "contention-fixture",
				submittedByUserId: "contention-fixture",
				quoteId: quote.id,
				productKey: quote.productKey,
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				inputSnapshot: {},
				pricingSnapshot: {},
				creditsReserved: 1n,
				idempotencyKey: randomUUID(),
				status: "PROVIDER_RUNNING",
			},
		});
		const attempt = await db.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: "nano-banana-2-lite",
				providerTaskId: "contention-only",
				status: "RUNNING",
				requestSnapshot: {},
			},
		});
		const account = await db.creditAccount.create({
			data: { ownerType: "USER", ownerId: "contention-fixture" },
		});
		await db.creditReservation.create({
			data: { accountId: account.id, jobId: job.id, amount: 1n },
		});
		await db.outboxEvent.create({
			data: {
				aggregateType: "GENERATION_JOB",
				aggregateId: job.id,
				eventType: "GENERATION_CANCEL_REQUESTED",
				dedupeKey: `generation-cancel:${job.id}`,
				payload: { jobId: job.id },
				status: "PROCESSED",
			},
		});
		occupyMaintenance = async () => {
			const { Client } = createRequire(path.join(root, "packages/database/package.json"))("pg");
			const lock = new Client({ connectionString: databaseUrl });
			await lock.connect();
			try {
				await lock.query("BEGIN");
				await lock.query("SELECT id FROM generation_attempt WHERE id=$1 FOR UPDATE", [attempt.id]);
				mark("maintenance.locked");
				const body = JSON.stringify({
					request: { taskId: "media-cancel-generation", payload: { jobId: job.id, version: 0 } },
					context: { attempt: 1, maxAttempts: 5, runId: "controlled-maintenance" },
				});
				const timestamp = String(Date.now());
				const signature = createHmac("sha256", secret)
					.update(`POST\n/internal/execute\n${timestamp}\n${body}`)
					.digest("hex");
				const execution = nativeFetch("http://127.0.0.1:9561/internal/execute", {
					method: "POST",
					body,
					headers: { "x-jobs-timestamp": timestamp, "x-jobs-signature": signature },
				});
				await new Promise((r) => setTimeout(r, 3500));
				await lock.query("ROLLBACK");
				const response = await execution;
				mark("maintenance.released", { status: response.status });
				await response.arrayBuffer();
			} finally {
				await lock.end();
			}
		};
	}
	async function seedCase(caseIndex: number) {
		const ownerId = randomUUID();
		const now = new Date();
		identityCases.set(ownerId, caseIndex);
		enrolledCases.set(caseIndex, { ownerId });
		await db.user.create({
			data: {
				id: ownerId,
				email: `${ownerId}@scanless.invalid`,
				name: "Local integration",
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
		});
		const account = await db.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		await database.createCreditGrant(
			{ accountId: account.id, amount: 100n, referenceKey: `fixture:${ownerId}` },
			db,
		);
		const plan = await db.billingPlan.create({
			data: {
				provider: "fixture",
				providerPriceId: ownerId,
				name: "creator",
				creditsPerPeriod: 700n,
				priceMicros: 19000000n,
				currency: "USD",
				metadata: { planId: "creator" },
			},
		});
		const end = new Date(now.getTime() + 86400000);
		const subscription = await db.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "fixture",
				providerSubscriptionId: ownerId,
				planId: plan.id,
				status: "ACTIVE",
				currentPeriodStart: now,
				currentPeriodEnd: end,
			},
		});
		await db.billingPeriod.create({
			data: {
				subscriptionId: subscription.id,
				startsAt: now,
				endsAt: end,
				status: "ACTIVE",
				paidAmount: plan.priceMicros,
				creditAmount: plan.creditsPerPeriod,
				providerInvoicePaymentId: ownerId,
			},
		});
		const token = randomUUID();
		await db.session.create({
			data: {
				id: randomUUID(),
				userId: ownerId,
				token,
				expiresAt: end,
				createdAt: now,
				updatedAt: now,
			},
		});
		const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`)}`;
		const reference = {
			v: 1 as const,
			ownerId,
			assetId: uploadReviewMode ? "" : randomUUID(),
			contentType: "image/png" as const,
			bytes: png.length,
			checksum: "",
			createdAt: now.toISOString(),
			expiresAt: end.toISOString(),
		};
		const preparationStartedAt = Date.now();
		let preparationEventIds: string[] = [];
		if (!uploadReviewMode) {
			identityCases.set(reference.assetId, caseIndex);
			enrolledCases.get(caseIndex)!.inputAssetId = reference.assetId;
			mark("preparation.started", { caseIndex, ...measurementModes, at: preparationStartedAt });
			const reservation = await database.reserveTemporaryReference(
				{
					ownerId,
					assetId: reference.assetId,
					bytes: png.length,
					expiresAt: end,
					maximumBytes: 10000000n,
				},
				db,
			);
			const written = await storage.putTemporaryReferenceObject({
				bucket: "media",
				key: temporaryReferenceObjectKey(reference),
				contentType: "image/png",
				contentLength: png.length,
				body: new Response(png).body!,
			});
			reference.checksum = written.sha256;
			if (measurementModes.inputReviewMode === "pre-reviewed") {
				const verification = temporaryReferenceVerificationProfile(env);
				assert(verification, "PRE_REVIEW_PROFILE_UNAVAILABLE");
				const committed = await database.commitTemporaryReferenceVerificationTransaction(
					{ ownerId, reservationId: reservation.id, reference, verification },
					db,
				);
				preparationEventIds = committed.continuationEventIds;
				assert.equal(preparationEventIds.length, 1, "PRE_REVIEW_INTENT_MISSING");
			} else {
				await database.finalizeStorageUsageReservation(reservation.id, "COMMITTED", db);
			}
		}
		const preparationPersistedAt = Date.now();
		if (!uploadReviewMode)
			mark("preparation.persisted", { caseIndex, at: preparationPersistedAt, preparationEventIds });
		const input = {
			productKey: "image-nano-banana-2-lite" as const,
			input: {
				kind: "image-to-image" as const,
				prompt: `A blue mountain landscape. fixture-case-${caseIndex}-end`,
				sourceAssetId: reference.assetId,
				skuKey: "nano-banana-2-lite-1k" as const,
				aspectRatio: "auto" as const,
			},
			temporaryReferenceToken: uploadReviewMode ? "" : signTemporaryReference(reference),
			expectedCredits: "5",
			idempotencyKey: randomUUID(),
		};
		let resolveVisible!: (value: Record<string, unknown>) => void;
		const visible = new Promise<Record<string, unknown>>((resolve) => {
			resolveVisible = resolve;
		});
		const browserTimes: Record<string, unknown> = {};
		let completed = false;
		return {
			caseIndex,
			ownerId,
			accountId: account.id,
			cookie,
			reference,
			preparationStartedAt,
			preparationPersistedAt,
			preparationReadyAt: uploadReviewMode ? null : preparationPersistedAt,
			preparationEventIds,
			uploadStartedAt: undefined as number | undefined,
			uploadReturnedAt: undefined as number | undefined,
			preClickReview: null as ScanlessPreClickReviewObservation | null,
			input,
			visible,
			browserTimes,
			jobId: undefined as string | undefined,
			complete(data: Record<string, unknown>) {
				if (completed) return;
				completed = true;
				Object.assign(browserTimes, data);
				resolveVisible(browserTimes);
			},
		};
	}
	// Keep the historical seeded modes unchanged. Upload modes seed accounts only;
	// the browser must call the production upload handler before Generate can submit.
	const cases: Awaited<ReturnType<typeof seedCase>>[] = [];
	stage("seeding");
	for (let index = 0; index < concurrency; index++) cases.push(await seedCase(index));
	if (measurementModes.inputReviewMode === "pre-reviewed") {
		stage("pre-reviewing-inputs");
		await withinScanlessDeadline(
			"pre-review-inputs",
			Promise.all(
				cases.map(async (fixture) => {
					const preparationDeadline = Date.now() + caseTimeoutMs;
					mark("preparation.review.dispatched", { caseIndex: fixture.caseIndex });
					await dispatchJob(
						"media-deliver-events",
						{ eventIds: fixture.preparationEventIds },
						{
							idempotencyKey: `temporary-reference-review:${fixture.reference.assetId}`,
							timeoutMs: 3_000,
						},
					);
					for (;;) {
						assert(Date.now() < preparationDeadline, "PRE_REVIEW_DEADLINE_EXCEEDED");
						mark("preparation.status.request", { caseIndex: fixture.caseIndex });
						const asset = await db.mediaAsset.findUniqueOrThrow({
							where: { id: fixture.reference.assetId },
							select: { status: true, verificationValidUntil: true },
						});
						if (asset.status === "READY") {
							assert(
								asset.verificationValidUntil && asset.verificationValidUntil.getTime() > Date.now(),
								"PRE_REVIEW_READY_WITHOUT_VALID_VERIFICATION",
							);
							break;
						}
						assert.equal(asset.status, "VERIFYING", "PRE_REVIEW_FAILED");
						await new Promise((resolve) => setTimeout(resolve, 200));
					}
					const [jobs, reservations] = await Promise.all([
						db.generationJob.count({ where: { ownerType: "USER", ownerId: fixture.ownerId } }),
						db.creditReservation.count({ where: { accountId: fixture.accountId } }),
					]);
					assert.equal(jobs, 0, "PRE_REVIEW_CREATED_GENERATION_JOB");
					assert.equal(reservations, 0, "PRE_REVIEW_RESERVED_GENERATION_CREDITS");
					fixture.preparationReadyAt = Date.now();
					mark("preparation.ready", {
						caseIndex: fixture.caseIndex,
						at: fixture.preparationReadyAt,
						jobs,
						reservations,
					});
				}),
			),
			caseTimeoutMs,
		);
	}
	const checkpoint = async (phase: string) => {
		stage(phase);
		await withinScanlessDeadline(
			"checkpoint",
			writeFile(
				path.join(evidenceDirectory, `${label}.checkpoint.json`),
				JSON.stringify(
					{
						label,
						concurrency,
						measurementModes,
						lifecyclePhase,
						capturedAt: Date.now(),
						storageFreshReadEnabled,
						loginBonusReadCommittedEnabled,
						settlementFreshReadEnabled,
						...sqlMetrics.report,
						harnessSources,
						cases: cases.map((fixture) => ({
							caseIndex: fixture.caseIndex,
							ownerId: fixture.ownerId,
							accountId: fixture.accountId,
							inputAssetId: fixture.reference.assetId,
							jobId: fixture.jobId,
							browserTimes: fixture.browserTimes,
						})),
						observations,
						pendingCount: pending.size,
						backgroundErrors: backgroundErrors.map(String),
					},
					null,
					2,
				),
			),
			3000,
		);
	};
	await checkpoint("seeded");
	server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", origin);
		const caseIndex = Number(url.searchParams.get("case") ?? "0");
		const fixture = cases[caseIndex];
		try {
			const browserModule = browserModules.get(url.pathname);
			if (browserModule !== undefined) {
				res.setHeader("Content-Type", "text/javascript; charset=utf-8");
				res.setHeader("Cache-Control", "no-store");
				res.end(browserModule);
				return;
			}
			assert(fixture && Number.isSafeInteger(caseIndex), "UNKNOWN_FIXTURE_CASE");
			const headers = new Headers({ cookie: req.headers.cookie ?? "" });
			let body: unknown;
			if (url.pathname === "/api/media/temporary-references") {
				assert(uploadReviewMode, "UPLOAD_ROUTE_REQUIRES_REAL_UPLOAD_MODE");
				assert.equal(req.method, "POST");
				assert.equal(fixture.input.temporaryReferenceToken, "", "DUPLICATE_FIXTURE_UPLOAD");
				const uploadHeaders = new Headers();
				for (const [name, value] of Object.entries(req.headers))
					if (value !== undefined)
						uploadHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
				const startedAt = Number(uploadHeaders.get("x-scanless-upload-started-at"));
				assert(Number.isFinite(startedAt) && startedAt > 0, "UPLOAD_START_MISSING");
				fixture.uploadStartedAt = startedAt;
				fixture.preparationStartedAt = startedAt;
				mark("preparation.started", { caseIndex, ...measurementModes, at: startedAt });
				mark("preparation.upload.started", { caseIndex, at: startedAt });
				const response = await uploadTemporaryReference(
					new Request(url, {
						method: "POST",
						headers: uploadHeaders,
						body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
						duplex: "half",
					} as RequestInit),
					undefined,
					createScanlessRequestDefer({
						mode: measurementModes.admissionDispatchMode,
						pending,
						onError: (error) => backgroundErrors.push(error),
						onEvent: (phase) => mark(`preparation.upload.defer.${phase}`, { caseIndex }),
					}),
				);
				body = await response.json();
				if (response.ok) {
					const uploaded = body as { assetId: string; token: string };
					Object.assign(
						fixture.reference,
						verifyTemporaryReference(uploaded.token, fixture.ownerId, uploaded.assetId),
					);
					fixture.input.input.sourceAssetId = uploaded.assetId;
					fixture.input.temporaryReferenceToken = uploaded.token;
					identityCases.set(uploaded.assetId, caseIndex);
					enrolledCases.get(caseIndex)!.inputAssetId = uploaded.assetId;
					fixture.preparationPersistedAt = Date.now();
					mark("preparation.persisted", {
						caseIndex,
						assetId: uploaded.assetId,
						at: fixture.preparationPersistedAt,
						source: "upload-handler-returned",
					});
				}
				res.statusCode = response.status;
				res.setHeader("Cache-Control", "no-store");
			} else if (url.pathname === "/reference-status") {
				assert(uploadReviewMode && fixture.input.temporaryReferenceToken, "REFERENCE_NOT_UPLOADED");
				mark("preparation.status.request", {
					caseIndex,
					source: "authenticated-product-procedure",
				});
				body = await call(
					getTemporaryReferenceStatus,
					{
						assetId: fixture.reference.assetId,
						token: fixture.input.temporaryReferenceToken,
					},
					{ context: { headers, requestId: randomUUID() } },
				);
				res.setHeader("Cache-Control", "no-store");
			} else if (url.pathname === "/start") {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(chunk);
				Object.assign(fixture.browserTimes, JSON.parse(Buffer.concat(chunks).toString()));
				const requestId = randomUUID();
				identityCases.set(requestId, caseIndex);
				mark("click", { caseIndex, requestId });
				const result = await runWithDatabaseClient(admissionDatabase(caseIndex), () =>
					call(submitGeneration, fixture.input, {
						context: {
							headers,
							requestId,
							defer: createScanlessRequestDefer({
								mode: measurementModes.admissionDispatchMode,
								pending,
								onError: (error) => backgroundErrors.push(error),
								onEvent: (phase) => mark(`admission.defer.${phase}`, { caseIndex, requestId }),
							}),
						},
					}),
				);
				fixture.jobId = result.job.id;
				enrolledCases.get(caseIndex)!.jobId = fixture.jobId;
				mark("admission.returned", { caseIndex, jobId: fixture.jobId });
				body = result;
			} else if (url.pathname === "/status") {
				mark("browser.status.request", { caseIndex, jobId: fixture.jobId });
				body = await call(
					getJob,
					{ jobId: fixture.jobId },
					{ context: { headers, requestId: randomUUID() } },
				);
			} else if (url.pathname === "/visible" || url.pathname === "/failed") {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(chunk);
				const data = JSON.parse(Buffer.concat(chunks).toString());
				mark(url.pathname === "/visible" ? "browser.visible" : "browser.failed", {
					...data,
					caseIndex,
				});
				if (url.pathname === "/visible" && browserMode === "notifications")
					Object.assign(fixture.browserTimes, data);
				else if (url.pathname === "/failed" && typeof fixture.browserTimes.visible === "number") {
					const { notifications, notificationConnections, ...failure } = data;
					fixture.complete({
						...failure,
						notificationFailureSnapshot: { notifications, notificationConnections },
					});
				} else fixture.complete(data);
				body = { ok: true };
			} else if (url.pathname === "/notification-observation") {
				assert.equal(browserMode, "notifications");
				assert.equal(typeof fixture.browserTimes.visible, "number");
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(chunk);
				const notificationObservation = JSON.parse(Buffer.concat(chunks).toString());
				mark("browser.notification.observation", { caseIndex, ...notificationObservation });
				fixture.complete({ notificationObservation });
				body = { ok: true };
			} else if (url.pathname === "/") {
				res.setHeader("Content-Type", "text/html");
				res.setHeader("Set-Cookie", `${fixture.cookie}; Path=/; HttpOnly; SameSite=Lax`);
				res.end(
					`<button id="start">Generate fixture</button><img id="image"><script type="module">
import {connectMediaJobEvents} from '${SCANLESS_JOB_EVENTS_MODULE}';
import {connectScanlessJobNotifications} from '${SCANLESS_NOTIFICATION_OBSERVER_MODULE}';
import {createScanlessNotificationObservation} from '${SCANLESS_NOTIFICATION_OBSERVATION_MODULE}';
document.getElementById('start').onclick=async()=>{
 const image=document.getElementById('image');
 const click=Date.now(), clickMonotonic=performance.now();
 const query='?case=${caseIndex}';
 const apiResources=()=>performance.getEntriesByType('resource').filter(entry=>['/start','/status'].includes(new URL(entry.name).pathname)).map(entry=>({
  path:new URL(entry.name).pathname,epochStart:performance.timeOrigin+entry.startTime,startTime:entry.startTime,
  duration:entry.duration,fetchStart:entry.fetchStart,requestStart:entry.requestStart,responseStart:entry.responseStart,responseEnd:entry.responseEnd,
  connectStart:entry.connectStart,connectEnd:entry.connectEnd,nextHopProtocol:entry.nextHopProtocol
 }));
 let stopNotifications;
 const notificationObservation=createScanlessNotificationObservation();
 const notificationConnections=[];
 const notificationProtocolFrames=[], notificationHealth=[];
 try {
 const submitted=await(await fetch('/start'+query,{method:'POST',body:JSON.stringify({click,monotonic:{click:clickMonotonic}})})).json();
 if(!submitted.job?.id) throw new Error(submitted.error || 'SUBMISSION_FAILED');
 const useNotifications=${browserMode === "notifications"};
 let notificationVersion=0, wake;
 if(useNotifications){
  stopNotifications=connectScanlessJobNotifications({
   connect:connectMediaJobEvents,
   jobId:submitted.job.id,
   url:location.origin.replace('http','ws')+'/api/media/jobs/'+submitted.job.id+'/events',
   onNotification:message=>notificationObservation.record(message),
   onProtocolFrame:event=>notificationProtocolFrames.push({...event,at:Date.now(),monotonic:performance.now()}),
   onHealthChange:healthy=>notificationHealth.push({healthy,at:Date.now(),monotonic:performance.now()}),
   onConnection:event=>notificationConnections.push({...event,at:Date.now(),monotonic:performance.now()}),
   refresh:async()=>{notificationVersion++;if(wake) wake();}
  });
 }
 for(;;){
  const beforeReadVersion=notificationVersion;
  const state=await(await fetch('/status'+query)).json();
  if(state.error) throw new Error(state.error);
  if(['FAILED','CANCELED'].includes(state.job?.status)) throw new Error('TERMINAL_JOB_'+state.job.status);
  const asset=state.assets?.[0];
  if(asset?.preview?.url){
   const received=Date.now(), receivedMonotonic=performance.now();
   image.src=asset.preview.url;
   await image.decode();
   const decoded=Date.now(), decodedMonotonic=performance.now();
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const visible=Date.now(), visibleMonotonic=performance.now();
   const bounds=image.getBoundingClientRect();
   const imageStyle=getComputedStyle(image);
   const intersectsViewport=bounds.width>0 && bounds.height>0 && bounds.right>0 && bounds.bottom>0 && bounds.left<innerWidth && bounds.top<innerHeight && imageStyle.visibility==='visible' && imageStyle.display!=='none' && Number(imageStyle.opacity)>0;
   if(!intersectsViewport) throw new Error('DECODED_IMAGE_NOT_VISIBLE_IN_VIEWPORT');
   const resource=performance.getEntriesByName(asset.preview.url,'resource').at(-1);
   const observed=useNotifications?notificationObservation.waitForReady({
    jobId:submitted.job.id,assetId:asset.id,visibleAt:visible,visibleMonotonic
   }).then(result=>{
    if(stopNotifications) stopNotifications();
    return {...result,notificationConnections:[...notificationConnections],notificationProtocolFrames:[...notificationProtocolFrames],notificationHealth:[...notificationHealth],disconnectRequestedAt:Date.now(),disconnectRequestedMonotonic:performance.now()};
   }):null;
   await fetch('/visible'+query,{method:'POST',body:JSON.stringify({
    click,received,decoded,visible,notifications:notificationObservation.snapshot(),notificationConnections,notificationProtocolFrames,notificationHealth,apiResources:apiResources(),
    naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,intersectsViewport,
    bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},
    monotonic:{click:clickMonotonic,received:receivedMonotonic,decoded:decodedMonotonic,visible:visibleMonotonic},
    resource:resource?{duration:resource.duration,startTime:resource.startTime,responseEnd:resource.responseEnd,transferSize:resource.transferSize,encodedBodySize:resource.encodedBodySize}:null
   })});
   if(observed) await fetch('/notification-observation'+query,{method:'POST',body:JSON.stringify(await observed)});
   break;
  }
  await new Promise(resolve=>{
   const done=()=>{clearTimeout(timer);wake=undefined;resolve();};
   const timer=setTimeout(done,${browserPollMs});
   if(useNotifications){wake=done;if(notificationVersion!==beforeReadVersion) done();}
  });
 }
 } catch(error) {
  notificationObservation.cancel();
  if(stopNotifications) stopNotifications();
  await fetch('/failed'+query,{method:'POST',body:JSON.stringify({click,endedAt:Date.now(),error:String(error),notifications:notificationObservation.snapshot(),notificationConnections,notificationProtocolFrames,notificationHealth,apiResources:apiResources()})});
 }
};</script>`,
				);
				return;
			} else {
				res.statusCode = 404;
				res.end();
				return;
			}
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(body));
		} catch (error) {
			console.error(error);
			fixture?.complete({ error: String(error), endedAt: Date.now() });
			res.statusCode = 500;
			res.end(JSON.stringify({ error: String(error) }));
		}
	});
	if (browserMode === "notifications") {
		const namespace = createScanlessSubscriptionNamespace((url, init) =>
			runtime.dispatchFetch(url, init),
		);
		const { WebSocketServer } = wr("ws");
		const upgrades = new WebSocketServer({ noServer: true });
		closeConnections.push(() => {
			for (const client of upgrades.clients) client.terminate();
			upgrades.close();
		});
		server.on("upgrade", (request, socket, head) => {
			void (async () => {
				const jobId = /^\/api\/media\/jobs\/([^/]+)\/events$/.exec(
					new URL(request.url ?? "/", origin).pathname,
				)?.[1];
				const headers = new Headers();
				for (const [name, value] of Object.entries(request.headers))
					if (value !== undefined)
						headers.set(name, Array.isArray(value) ? value.join(", ") : value);
				// Actual production auth/ownership handler; only the Node-to-workerd
				// upgrade transport differs from the production website Worker.
				const response = await runWithMediaJobEvents(namespace, () =>
					serveMediaJobEvents(new Request(new URL(request.url ?? "/", origin), { headers })),
				);
				const upstream = (
					response as Response & {
						webSocket?: {
							accept(): void;
							send(value: string): void;
							close(code: number, reason?: string): void;
							addEventListener(
								type: string,
								listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
							): void;
						};
					}
				).webSocket;
				if (response.status !== 101 || !upstream) {
					socket.end(`HTTP/1.1 ${response.status} Rejected\r\nConnection: close\r\n\r\n`);
					mark("browser.notification.rejected", { jobId, status: response.status });
					return;
				}
				upgrades.handleUpgrade(
					request,
					socket,
					head,
					(client: {
						send(value: string): void;
						close(code: number, reason?: string): void;
						on(type: "close", listener: (code: number, reason: Uint8Array) => void): void;
						on(type: "error", listener: () => void): void;
						on(type: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
					}) => {
						upstream.addEventListener("message", (event) => {
							assert.equal(typeof event.data, "string");
							client.send(event.data as string);
						});
						upstream.addEventListener("close", (event) => {
							const close = scanlessWebSocketClose(event.code, event.reason);
							mark("browser.notification.closed", { jobId, ...close });
							client.close(close.code, close.reason);
						});
						upstream.addEventListener("error", () => client.close(1011));
						client.on("close", (code, reason) => {
							const close = scanlessWebSocketClose(code, new TextDecoder().decode(reason));
							upstream.close(close.code, close.reason);
						});
						client.on("error", () => upstream.close(1011));
						client.on("message", (data, isBinary) => {
							if (isBinary || data.byteLength > 2_048) {
								client.close(1008);
								return;
							}
							// Carry real v2 heartbeat frames to the production hub, which validates them.
							upstream.send(data.toString("utf8"));
						});
						upstream.accept();
						mark("browser.notification.connected", { jobId });
					},
				);
			})().catch((error) => {
				backgroundErrors.push(error);
				console.error(error);
				socket.destroy();
			});
		});
	}
	await new Promise<void>((r) => server!.listen(9560, "127.0.0.1", r));
	const { chromium } = createRequire(path.join(root, "apps/saas/package.json"))("@playwright/test");
	browser = await chromium.launch({
		headless: true,
		args: [
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
		],
	});
	const pages = await Promise.all(
		cases.map(async (fixture) => {
			const context = await browser!.newContext();
			const page = await context.newPage();
			await page.goto(`${origin}/?case=${fixture.caseIndex}`);
			return page;
		}),
	);
	mark("cohort.prepared", { expectedCount: concurrency });
	await checkpoint("cohort-prepared");
	const deadlines = cases.map((fixture) => {
		const timer = setTimeout(() => {
			mark("case.timeout", { caseIndex: fixture.caseIndex, jobId: fixture.jobId });
			fixture.complete({ timeout: true, endedAt: Date.now() });
		}, caseTimeoutMs);
		timers.add(timer);
		return timer;
	});
	// All contexts load before concurrent starts. Real uploads begin together, then
	// each user clicks at its own observed review checkpoint. Never hold a pending
	// user's click behind the other uploads; retain actual click spread in the report.
	await Promise.all(
		pages.map(async (page, caseIndex) => {
			try {
				if (uploadReviewMode) {
					const fixture = cases[caseIndex]!;
					const uploaded = await page.evaluate(
						async ({
							base64,
							caseIndex,
							timeoutMs,
						}: {
							base64: string;
							caseIndex: number;
							timeoutMs: number;
						}) => {
							const bytes = Uint8Array.from(atob(base64), (byte) => byte.charCodeAt(0));
							const startedAt = Date.now();
							const response = await fetch(`/api/media/temporary-references?case=${caseIndex}`, {
								method: "POST",
								headers: {
									"Content-Type": "image/png",
									"x-upload-size": String(bytes.length),
									"x-scanless-upload-started-at": String(startedAt),
								},
								body: bytes,
								signal: AbortSignal.timeout(timeoutMs),
							});
							const result = await response.json();
							if (!response.ok || !result.assetId || !result.token)
								throw new Error(
									`TEMPORARY_REFERENCE_UPLOAD_FAILED:${result.code ?? response.status}`,
								);
							return { startedAt, returnedAt: Date.now(), assetId: result.assetId };
						},
						{ base64: png.toString("base64"), caseIndex, timeoutMs: caseTimeoutMs },
					);
					fixture.uploadReturnedAt = uploaded.returnedAt;
					mark("preparation.upload.returned", {
						caseIndex,
						assetId: uploaded.assetId,
						at: uploaded.returnedAt,
					});
					fixture.preClickReview = await observeScanlessPreClickReview({
						mode: uploadReviewMode,
						deadlineAt: uploaded.startedAt + caseTimeoutMs,
						now: Date.now,
						readStatus: () =>
							page.evaluate(
								async ({ index, timeoutMs }: { index: number; timeoutMs: number }) => {
									const response = await fetch(`/reference-status?case=${index}`, {
										signal: AbortSignal.timeout(timeoutMs),
									});
									const result = await response.json();
									if (!response.ok || !result.status)
										throw new Error(
											`TEMPORARY_REFERENCE_STATUS_FAILED:${result.error ?? response.status}`,
										);
									return result as { status: ScanlessReferenceReviewStatus };
								},
								{
									index: caseIndex,
									timeoutMs: Math.max(1, uploaded.startedAt + caseTimeoutMs - Date.now()),
								},
							),
						wait: () => new Promise((resolve) => setTimeout(resolve, preReviewPollMs)),
						onObservation: (observation) =>
							mark("preparation.review.observed", { caseIndex, ...observation }),
					});
					fixture.preparationReadyAt = Date.now();
					mark("preparation.ready", {
						caseIndex,
						at: fixture.preparationReadyAt,
						status: fixture.preClickReview.status,
					});
				}
				await page.click("#start");
			} catch (error) {
				cases[caseIndex]!.complete({ error: String(error), endedAt: Date.now() });
			}
		}),
	);
	await Promise.all(cases.map((fixture) => fixture.visible));
	for (const timeout of deadlines) {
		clearTimeout(timeout);
		timers.delete(timeout);
	}
	await checkpoint("browser-outcomes-recorded");
	// Inspection queries start after every user has either seen the result or
	// failed/timed out, so harness accounting reads do not load another user's path.
	for (let index = 0; index < 60; index++) {
		const unsettled = await withinScanlessDeadline(
			"settlement-observation",
			db.generationJob.count({
				where: {
					id: { in: cases.flatMap((fixture) => (fixture.jobId ? [fixture.jobId] : [])) },
					status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] },
				},
			}),
			3000,
		).catch((error) => {
			backgroundErrors.push(error);
			return -1;
		});
		if (unsettled === -1) break;
		if (unsettled === 0) break;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	stage("draining-fixture-callbacks");
	await withinScanlessDeadline("pending-fixture-callbacks", Promise.all(pending), 3000).catch(
		(error) => backgroundErrors.push(error),
	);
	await checkpoint("inspecting-accounting");
	const artifactSha256 = createHash("sha256")
		.update(await readFile(path.join(output, "workers.js")))
		.digest("hex");
	const browserConfiguration = {
		mode: `minimal-preview-${browserMode}`,
		pollIntervalMs: browserPollMs,
		referenceReviewPollIntervalMs: uploadReviewMode ? preReviewPollMs : null,
		isFullSaasUi: false,
		chromiumProcesses: 1,
		independentContexts: concurrency,
		backgroundThrottlingDisabledForCohort: true,
		notificationObservation:
			browserMode === "notifications"
				? {
						deadlineAfterVisibleMs: SCANLESS_NOTIFICATION_OBSERVATION_MS,
						additionalModuleGetsBeforeClickPerCase: 1,
						additionalPostsPerCase: 1,
						maximumDeadlineTimersPerCase: 1,
						additionalStatusOrDatabaseReads: 0,
						note: "Receipt collection only; original visible time and performance budgets are unchanged.",
					}
				: null,
		resourceTimingNote: "Cross-origin transfer sizes may be redacted without Timing-Allow-Origin.",
	};
	const inspectCase = async (fixture: (typeof cases)[number]) => {
		const { caseIndex, ownerId, reference, browserTimes, jobId } = fixture;
		const ownObservations = observations.filter((row) => row.caseIndex === caseIndex);
		const sourceDownloadRequests = ownObservations.filter(
			(row) => row.stage === "supplier.output.download",
		).length;
		const errors: string[] = [];
		const check = (condition: unknown, message: string) => {
			if (!condition) errors.push(message);
		};
		check(!browserTimes.timeout, "NO_VISIBLE_OUTPUT_WITH_SCANNER_DISABLED");
		check(
			!browserTimes.error,
			typeof browserTimes.error === "string" ? browserTimes.error : "BROWSER_FAILED",
		);
		check(browserTimes.naturalWidth === outputFixture.metadata.width, "DECODED_OUTPUT_WIDTH");
		check(browserTimes.naturalHeight === outputFixture.metadata.height, "DECODED_OUTPUT_HEIGHT");
		check(browserTimes.intersectsViewport === true, "DECODED_IMAGE_NOT_VISIBLE_IN_VIEWPORT");
		const base = {
			label: `${label}:case-${caseIndex}`,
			caseIndex,
			ownerId,
			accountId: fixture.accountId,
			idempotencyKey: fixture.input.idempotencyKey,
			outputBytes,
			outputFixture: outputFixture.metadata,
			artifactSha256,
			browser: browserConfiguration,
			browserTimes,
			preClickReview: fixture.preClickReview,
			observations: ownObservations,
			sourceDownloadRequests,
		};
		try {
			const job = jobId
				? await db.generationJob.findUnique({
						where: { id: jobId },
						include: { attempts: true, reservation: true, assets: { include: { asset: true } } },
					})
				: null;
			const asset = job?.assets.find((item) => item.role === "OUTPUT")?.asset;
			if (asset) identityCases.set(asset.id, caseIndex);
			const ledger = job?.reservation
				? await db.creditLedgerEntry.findMany({
						where: { reservationId: job.reservation.id },
						select: { type: true, amount: true, referenceKey: true },
						orderBy: { createdAt: "asc" },
					})
				: [];
			const notificationEvents = jobId
				? await db.outboxEvent.findMany({
						where: { eventType: "MEDIA_JOB_UPDATED", aggregateId: jobId },
						select: { id: true, status: true, payload: true, processedAt: true },
					})
				: [];
			const ownReviews = [...reviews].filter(([, review]) => review.caseIndex === caseIndex);
			if (uploadReviewMode) {
				const inputAsset = await db.mediaAsset.findUnique({
					where: { id: reference.assetId },
					select: { verificationProviderTaskId: true },
				});
				errors.push(
					...scanlessUploadPreReviewErrors({
						mode: uploadReviewMode,
						clickAt: browserTimes.click,
						uploadStartedAt: fixture.uploadStartedAt,
						uploadReturnedAt: fixture.uploadReturnedAt,
						preClickReview: fixture.preClickReview,
						reviews: ownReviews
							.filter(([, review]) => review.role === "input")
							.map(([id, review]) => ({ id, readyAt: review.readyAt })),
						persistedProviderTaskId: inputAsset?.verificationProviderTaskId ?? null,
					}),
				);
			}
			check(job?.attempts.length === 1, "GENERATION_ATTEMPT_COUNT");
			check(job?.ownerId === ownerId && job?.submittedByUserId === ownerId, "JOB_OWNER_MISMATCH");
			check(job?.reservation?.accountId === fixture.accountId, "RESERVATION_ACCOUNT_MISMATCH");
			check(asset?.ownerId === ownerId, "OUTPUT_OWNER_MISMATCH");
			check(
				job?.attempts.every(
					(attempt) =>
						attempt.providerTaskId &&
						generations.get(attempt.providerTaskId)?.caseIndex === caseIndex,
				),
				"PROVIDER_TASK_OWNER_MISMATCH",
			);
			check(
				[...generations.values()].filter((item) => item.caseIndex === caseIndex).length === 1,
				"MODEL_SUBMISSION_COUNT",
			);
			check(job?.status === "SUCCEEDED", `JOB_NOT_SUCCEEDED:${job?.status ?? "absent"}`);
			check(
				ownReviews.filter(([, review]) => review.role === "input").length === 1,
				"INPUT_REVIEW_COUNT",
			);
			check(
				ownReviews.filter(([, review]) => review.role === "output").length === 1,
				"OUTPUT_REVIEW_COUNT",
			);
			if (expectedSourceReads !== undefined)
				check(sourceDownloadRequests === Number(expectedSourceReads), "SUPPLIER_OUTPUT_REOPENED");
			check(ledger.filter((entry) => entry.type === "RESERVE").length === 1, "RESERVATION_COUNT");
			check(ledger.filter((entry) => entry.type === "SETTLE").length === 1, "SETTLEMENT_COUNT");
			check(job?.reservation?.settledAmount === 5n, "SETTLED_AMOUNT");
			if (imageCallbacks)
				for (const [id] of ownReviews) {
					check(
						ownObservations.some(
							(row) =>
								row.stage === "seeapi.callback.returned" && row.id === id && row.status === 202,
						),
						"IMAGE_REVIEW_CALLBACK_NOT_COMPLETED",
					);
					if (delay > 0)
						check(
							ownObservations.some(
								(row) => row.stage === "seeapi.query" && row.id === id && row.done,
							),
							"CALLBACK_MUST_RETRIEVE_AUTHENTICATED_VERDICT",
						);
				}
			const earlyCallbackCases = [...generations]
				.filter(([, item]) => item.caseIndex === caseIndex)
				.map(([id]) => {
					const callback = ownObservations.find(
						(row) => row.stage === "kie.callback.returned" && row.id === id,
					);
					const response = ownObservations.find(
						(row) => row.stage === "kie.submit.responded" && row.id === id,
					);
					return {
						providerTaskId: id,
						callbackAt: callback?.at ?? null,
						callbackStatus: callback?.status ?? null,
						submitResponseAt: response?.at ?? null,
						callbackBeforeSubmitResponse:
							typeof callback?.at === "number" && typeof response?.at === "number"
								? callback.at < response.at
								: null,
					};
				});
			if (generationResponseDelay > generationDelay)
				check(
					earlyCallbackCases.length === 1 &&
						earlyCallbackCases.every(
							(item) => item.callbackBeforeSubmitResponse === true && item.callbackStatus === 202,
						),
					"EARLY_KIE_CALLBACK_RACE_NOT_EXERCISED",
				);
			const readyEvents = notificationEvents.filter((event) => {
				const payload = event.payload as {
					eventId?: unknown;
					jobId?: unknown;
					version?: unknown;
				} | null;
				return (
					asset &&
					payload?.eventId === event.id &&
					payload?.jobId === jobId &&
					typeof payload?.version === "string" &&
					payload.version.startsWith(`asset:${asset.id}:`) &&
					payload.version.endsWith(":ready")
				);
			});
			check(
				readyEvents.some((event) => event.status === "PROCESSED"),
				"READY_NOTIFICATION_NOT_CONFIRMED_PERSISTED",
			);
			check(readyEvents.length <= 1, "READY_NOTIFICATION_NOT_UNIQUE");
			if (browserMode === "notifications") {
				const readyEvent =
					readyEvents.length === 1 && readyEvents[0]?.status === "PROCESSED"
						? readyEvents[0]
						: undefined;
				check(
					jobId &&
						readyEvent &&
						hasScanlessCommittedReadyReceipt({
							jobId,
							eventId: readyEvent.id,
							version: (readyEvent.payload as { version: string }).version,
							observation: browserTimes.notificationObservation,
						}),
					"BROWSER_DID_NOT_RECEIVE_COMMITTED_READY_NOTIFICATION",
				);
			}
			const objects = await s3.send(
				new ListObjectsV2Command({ Bucket: env.MEDIA_BUCKET_NAME, Prefix: `users/${ownerId}/` }),
			);
			return {
				...base,
				outcome: browserTimes.timeout
					? ("timeout" as const)
					: errors.length
						? ("failed" as const)
						: ("succeeded" as const),
				errors,
				ledger: ledger.map((entry) => ({ ...entry, amount: entry.amount.toString() })),
				earlyCallbackCases,
				notifications: {
					enabled: true,
					browserSubscribed: browserMode === "notifications",
					events: notificationEvents,
				},
				job: {
					id: jobId ?? null,
					inputAssetId: reference.assetId,
					outputAssetId: asset?.id ?? null,
					attemptIds: job?.attempts.map((attempt) => attempt.id) ?? [],
					status: job?.status ?? null,
					storedTerminalAt: job?.terminalAt ?? null,
					attempts: job?.attempts.length ?? 0,
					settlement: String(job?.reservation?.settledAmount ?? "unknown"),
					finalizationAttempts: job?.finalizationRetryCount ?? null,
					assetReadyObservedUpdatedAt: asset?.updatedAt ?? null,
				},
				objectKeys: objects.Contents?.map((object: { Key: string }) => object.Key) ?? [],
			};
		} catch (error) {
			return {
				...base,
				outcome: browserTimes.timeout ? ("timeout" as const) : ("failed" as const),
				errors: [...errors, String(error)],
				job: { id: jobId ?? null, inputAssetId: reference.assetId },
				ledger: [],
			};
		}
	};
	const rawCaseReports = await Promise.all(
		cases.map((fixture) =>
			withinScanlessDeadline(
				`case-accounting-${fixture.caseIndex}`,
				inspectCase(fixture),
				10_000,
			).catch((error) => ({
				caseIndex: fixture.caseIndex,
				ownerId: fixture.ownerId,
				accountId: fixture.accountId,
				outcome: "timeout" as const,
				errors: [String(error)],
				browserTimes: fixture.browserTimes,
				job: { id: fixture.jobId ?? null, inputAssetId: fixture.reference.assetId },
				ledger: [],
				observations: observations.filter((row) => row.caseIndex === fixture.caseIndex),
			})),
		),
	);
	const caseReports = rawCaseReports.map((report, caseIndex) => ({
		...report,
		measurementModes,
		measurementTimeline: scanlessMeasurementTimeline({
			preparationStartedAt: cases[caseIndex]!.preparationStartedAt,
			preparationReadyAt: cases[caseIndex]!.preparationReadyAt,
			uploadStartedAt: cases[caseIndex]!.uploadStartedAt,
			uploadReturnedAt: cases[caseIndex]!.uploadReturnedAt,
			click: cases[caseIndex]!.browserTimes.click,
			visible: cases[caseIndex]!.browserTimes.visible,
		}),
	}));
	const summary = {
		...summarizeConcurrentCases(concurrency, caseReports),
		measurementModes,
		inputPreparation: {
			method: uploadReviewMode
				? "authenticated-browser-upload-handler"
				: "historical-direct-storage-seed",
			statusReader: uploadReviewMode
				? "authenticated-product-procedure"
				: measurementModes.inputReviewMode === "pre-reviewed"
					? "historical-direct-database-observer"
					: "none-before-click",
			isFullSaasUi: false,
			allUsersLoadedBeforeUpload: Boolean(uploadReviewMode),
			clickBarrierAfterAllReviews: measurementModes.inputReviewMode === "pre-reviewed",
		},
		storageFreshReadEnabled,
		loginBonusReadCommittedEnabled,
		settlementFreshReadEnabled,
		...sqlMetrics.report,
	};
	const report = {
		...(concurrency === 1 ? caseReports[0] : {}),
		label,
		concurrency,
		measurementModes,
		summary,
		cases: caseReports,
		outputBytes,
		outputFixture: outputFixture.metadata,
		artifactSha256,
		harnessSources,
		databasePool: databasePool.report,
		lifecyclePhase,
		browser: browserConfiguration,
		maintenanceBusy,
		imageCallbacks,
		storageFreshReadEnabled,
		loginBonusReadCommittedEnabled,
		settlementFreshReadEnabled,
		...sqlMetrics.report,
		fixtureTiming: {
			processingClockVersion: 1,
			promptReviewDelayMs: promptReviewDelay,
			reviewDelayMs: delay,
			generationDelayMs: generationDelay,
			generationResponseDelayMs: generationResponseDelay,
		},
		environment:
			"One shared local workerd runtime/executor namespace + PostgreSQL + MinIO + Chromium; independent owners/accounts/cookies/contexts; supplier HTTP only fixed-time fixtures",
		scanner: "not scheduled",
		observations,
		backgroundErrors: backgroundErrors.map(String),
		identityMap: [...identityCases].map(([id, caseIndex]) => ({ id, caseIndex })),
		timingEvidence: {
			fixtureClock: "Node Date.now; browser monotonic durations also retained",
			localSqlTraceEnabled: sqlMetrics.enabled,
			localSqlTraceFormat: sqlMetrics.enabled ? sqlMetrics.format : null,
			necessaryDatabaseIoMs: null,
			necessaryNetworkIoMs: null,
			controllableOverheadMs: null,
			oneSecondCertified: false,
			limitations: [
				"Deferred dispatch changes response waiting, not total work. Upload modes call the real upload and status handlers in a minimal browser, retaining upload/preparation-to-visible time beside click-to-visible. Historical pre-reviewed mode seeds its reference directly and does not cover the upload entrypoint.",
				"Whole database/HTTP spans are not classified as unavoidable I/O.",
				sqlMetrics.enabled
					? "Opt-in Prisma query events may omit BEGIN/COMMIT. Shared Node client events without explicit IDs remain unassigned."
					: "SQL diagnostics are disabled. Query count, duration and client attribution are unavailable, not zero; this run is a supplemental performance observation, not one-second certification.",
				"Worker storage outbound uses a backpressured Node streaming bridge; this is not cloud memory proof.",
				"Asset updatedAt is observed after settlement and is not the READY transaction commit timestamp.",
				"One Chromium hosts separate contexts; same-host browser/HTTP/CPU contention is part of observed wall time.",
			],
		},
	};
	const directory = path.join(root, ".cache/first-image");
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, `${label}.json`), JSON.stringify(report, null, 2));
	stage("report-written");
	console.log("SCANLESS_RESULT", JSON.stringify({ label, ...summary, cases: undefined }));
	assert.equal(summary.allSucceeded, true, "COHORT_CONTAINS_FAILURE_TIMEOUT_OR_MISSING_CASE");
	assert.equal(backgroundErrors.length, 0, "BACKGROUND_FIXTURE_FAILURE");
	if (maintenanceBusy)
		assert(
			observations.some((row) => row.stage === "maintenance.released" && row.status === 200),
			"MAINTENANCE_DID_NOT_RUN",
		);
} catch (error) {
	const dir = path.join(root, ".cache/first-image");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, `${label}.failed.json`),
		JSON.stringify(
			{
				label,
				concurrency,
				outcome: "driver-failed",
				error: String(error),
				observedAt: Date.now(),
				outputFixture: outputFixture.metadata,
				browserMode,
				imageCallbacks,
				storageFreshReadEnabled,
				loginBonusReadCommittedEnabled,
				settlementFreshReadEnabled,
				...sqlMetrics.report,
				harnessSources,
				databasePool: databasePool.report,
				lifecyclePhase,
				observations,
				cases: Array.from({ length: concurrency }, (_, caseIndex) => ({
					caseIndex,
					...enrolledCases.get(caseIndex),
					outcome: "failed",
					error: `DRIVER_FAILED:${String(error)}`,
				})),
				oneSecondCertified: false,
			},
			null,
			2,
		),
	);
	throw error;
} finally {
	stage("cleanup");
	for (const timer of timers) clearTimeout(timer);
	const boundedCleanup = async (name: string, operation: PromiseLike<unknown>) => {
		await withinScanlessDeadline(name, operation, 3000).catch((error) => {
			console.error(String(error));
			process.exitCode = 1;
		});
	};
	await boundedCleanup("cleanup-fixtures", Promise.all(pending));
	await boundedCleanup("cleanup-browser", browser?.close() ?? Promise.resolve());
	for (const close of closeConnections) close();
	server?.closeAllConnections();
	await boundedCleanup(
		"cleanup-http",
		new Promise<void>((r) => (server ? server.close(() => r()) : r())),
	);
	for (const [index, dispose] of cleanup.reverse().entries())
		await boundedCleanup(`cleanup-${index}`, Promise.resolve().then(dispose));
	globalThis.fetch = nativeFetch;
	stage("cleanup-completed");
	await boundedCleanup("cleanup-journal", new Promise<void>((resolve) => journal.end(resolve)));
}
