import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import { createConfiguredVideoSafetyAdapter } from "@repo/ai/media/moderation/video-configured";
import { KieVideoV1Adapter } from "@repo/ai/media/providers/kie-video-v1";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { createCreditGrant, releaseCredits } from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { createVideoJobRecord, createVideoQuoteRecord } from "@repo/database/video-v1";
import { authorizeVideoPlayback } from "@repo/database/video-v1-fulfillment";
import {
	getVideoWaitWindow,
	getVideoWorkflowCheckpoint,
	markVideoNeedsReview,
} from "@repo/database/video-v1-recovery";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
	runVideoGenerationV1,
	type VideoDurableSteps,
	type VideoWorkflowServices,
} from "../../../../apps/workflows/src/video-orchestrator";
import { mp4Fixture } from "../../../storage/test-support/video-fixture";
import { ensureVideoWorkflowStarted } from "./admission";
import type { VideoWorkflowBinding, VideoRequestInput } from "./contracts";
import { failVideoJob, finalizeVideoJob, reviewStoredVideo, storeVideoOutput } from "./fulfillment";
import { acceptSeeapiVideoModerationWebhook } from "./seeapi-webhooks";
import { confirmVideoProviderResult, reviewVideoInput, submitVideoAttempt } from "./submission";
import { seeapiEnvelope } from "./video-safety.test-fixtures";
import { acceptVideoProviderWebhook } from "./webhooks";
import { runWithVideoWorkflowBinding } from "./workflow-binding";

// Only external transport/storage primitives are mocked. Real domain services,
// SQL transactions, ledger, provider serializers, policies and MP4 inspector run.
const external = vi.hoisted(() => ({
	objects: new Map<string, { bytes: Uint8Array; etag: string }>(),
	parts: new Map<string, Map<number, Uint8Array>>(),
	videoBytes: new Uint8Array(),
	requestedOutputs: [] as string[],
	outputReads: [] as string[],
	nextUpload: 0,
	paidMockCalls: 0,
	safetyCalls: 0,
	activeProviderCalls: 0,
	peakProviderCalls: 0,
	loseSubmitResponse: false,
	earlyCallbacks: true,
	tasks: new Map<string, { callbackUrl: string }>(),
	visualTasks: new Set<string>(),
	imageTasks: new Set<string>(),
}));
vi.mock("@repo/storage", async (original) => {
	const actual = await original<typeof import("@repo/storage")>();
	return {
		...actual,
		createSignedReadUrl: async ({ key }: { key: string }) =>
			`https://private.video.test/${encodeURIComponent(key)}`,
		abortIncompleteMultipartUploads: async () => 0,
		createMultipartUpload: async () => {
			const uploadId = `mock-upload-${++external.nextUpload}`;
			external.parts.set(uploadId, new Map());
			return { uploadId };
		},
		uploadMultipartPart: async ({
			uploadId,
			partNumber,
			body,
		}: {
			uploadId: string;
			partNumber: number;
			body: Uint8Array;
		}) => {
			external.parts.get(uploadId)!.set(partNumber, new Uint8Array(body));
			return `part-${partNumber}`;
		},
		abortMultipartUpload: async ({ uploadId }: { uploadId: string }) => {
			external.parts.delete(uploadId);
		},
		completeMultipartUpload: async ({
			key,
			uploadId,
			ifNoneMatch,
		}: {
			key: string;
			uploadId: string;
			ifNoneMatch?: string;
		}) => {
			if (ifNoneMatch !== "*" || external.objects.has(key))
				throw new Error("MOCK_IMMUTABILITY_CONFLICT");
			const parts = [...external.parts.get(uploadId)!.entries()]
				.sort(([a], [b]) => a - b)
				.map(([, value]) => value);
			const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
			let offset = 0;
			for (const part of parts) {
				bytes.set(part, offset);
				offset += part.byteLength;
			}
			external.objects.set(key, { bytes, etag: `mock-etag-${uploadId}` });
			external.parts.delete(uploadId);
		},
		headObject: async ({ key }: { key: string }) => {
			const object = external.objects.get(key);
			if (!object) throw Object.assign(new Error("missing"), { name: "NotFound" });
			return {
				contentLength: object.bytes.length,
				contentType: "video/mp4",
				etag: object.etag,
				metadata: {},
			};
		},
		readPrivateMediaStream: async ({ key, ifMatch }: { key: string; ifMatch?: string }) => {
			const object = external.objects.get(key);
			if (!object || ifMatch !== object.etag) throw new Error("MOCK_OBJECT_IDENTITY_CHANGED");
			external.outputReads.push(key);
			return {
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						for (let at = 0; at < object.bytes.length; at += 1024)
							controller.enqueue(object.bytes.subarray(at, at + 1024));
						controller.close();
					},
				}),
			};
		},
		requestRemoteMediaStream: (
			url: string,
			options: Parameters<typeof actual.requestRemoteMediaStream>[1],
		) => {
			external.requestedOutputs.push(url);
			return actual.requestRemoteMediaStream(url, {
				...options,
				resolve: async () => [{ address: "8.8.8.8", family: 4 as const }],
				request: async () => ({
					status: 200,
					headers: {
						"content-type": "video/mp4",
						"content-length": String(external.videoBytes.byteLength),
					},
					stream: Readable.from(
						(function* () {
							for (let at = 0; at < external.videoBytes.length; at += 1024)
								yield external.videoBytes.subarray(at, at + 1024);
						})(),
					),
				}),
			});
		},
	};
});

const fixtureKeys = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const env = {
	NODE_ENV: "test",
	KIE_API_KEY: "mock-only",
	KIE_WEBHOOK_SECRET: "mock-secret-only",
	VIDEO_V1_CALLBACK_BASE_URL: "https://app.video.test",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.video.test",
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	WAFFO_MERCHANT_ID: "MER_0000000000000000000000",
	WAFFO_PRIVATE_KEY: fixtureKeys.privateKey,
	SEEAPI_API_KEY: "mock-only",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local_test_signing_secret_20261004",
	}),
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-video-seeapi-callback-secret-20261004",
	MEDIA_MAX_STORAGE_BYTES: "1000000000",
};
const price = {
	credits: 7n,
	pricingVersion: "INTEGRATION_TEST_ONLY",
	providerCostMicros: 2n,
	moderationCostMicros: 1n,
	pricingBasis: "SYNTHETIC_TEST_ONLY_NOT_A_FORMAL_PRICE",
};
const visualSafetyProfile = createVideoVisualSafetyProfile("seeapi", 5);
const instances = new Set<string>();
const binding: VideoWorkflowBinding = {
	async create({ id }) {
		if (instances.has(id)) throw new Error("already exists");
		instances.add(id);
		return this.get(id);
	},
	async get(id) {
		if (!instances.has(id)) throw new Error("not found");
		return { status: async () => ({ status: "running" }), sendEvent: async () => undefined };
	},
};

async function callback(callbackUrl: string, taskId: string) {
	const timestamp = String(Math.floor(Date.now() / 1000));
	return acceptVideoProviderWebhook(
		new Request(callbackUrl, {
			method: "POST",
			headers: {
				"x-webhook-timestamp": timestamp,
				"x-webhook-signature": createHmac("sha256", env.KIE_WEBHOOK_SECRET)
					.update(`${taskId}.${timestamp}`)
					.digest("base64"),
			},
			// The unsigned URL is deliberately hostile; the authenticated query must win.
			body: JSON.stringify({
				data: { taskId, state: "fail", resultUrls: ["https://attacker.test/untrusted.mp4"] },
			}),
		}),
		{ environment: env, binding },
	);
}
const mockHttp: typeof fetch = async (input, init) => {
	const url = new URL(
		typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
	);
	if (url.hostname === "api.kie.ai" && url.pathname.endsWith("createTask")) {
		external.paidMockCalls++;
		external.activeProviderCalls++;
		external.peakProviderCalls = Math.max(external.peakProviderCalls, external.activeProviderCalls);
		if (typeof init?.body !== "string") throw new Error("MOCK_EXPECTED_JSON_BODY");
		const body = JSON.parse(init.body) as {
			model: string;
			callBackUrl: string;
			input: { duration: string; sound: boolean; image_urls?: string[]; aspect_ratio?: string };
		};
		expect(body.input.duration).toBe("5");
		expect(body.input.sound).toBe(false);
		if (body.model.endsWith("image-to-video")) {
			expect(body.input.image_urls).toHaveLength(1);
			expect(body.input.aspect_ratio).toBeUndefined();
		}
		const taskId = `mock_${crypto.randomUUID().replaceAll("-", "")}`;
		external.tasks.set(taskId, { callbackUrl: body.callBackUrl });
		try {
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (external.earlyCallbacks) {
				await callback(body.callBackUrl, taskId);
				await callback(body.callBackUrl, taskId);
			}
			if (external.loseSubmitResponse) {
				external.loseSubmitResponse = false;
				throw new Error("INJECTED_HTTP_RESPONSE_LOST_AFTER_ACCEPTANCE");
			}
			return Response.json({ code: 200, data: { taskId } });
		} finally {
			external.activeProviderCalls--;
		}
	}
	if (url.hostname === "api.kie.ai" && url.pathname.endsWith("recordInfo")) {
		const taskId = url.searchParams.get("taskId")!;
		if (!external.tasks.has(taskId)) throw new Error("UNEXPECTED_PROVIDER_TASK");
		return Response.json({
			code: 200,
			data: {
				taskId,
				state: "success",
				resultJson: JSON.stringify({ resultUrls: [`https://cdn.video.test/${taskId}.mp4`] }),
				creditsConsumed: 123,
				completeTime: Date.now(),
			},
		});
	}
	if (url.hostname === "api.waffo.ai" && url.pathname === "/v1/actions/verification/scan-prompt") {
		external.safetyCalls++;
		if (typeof init?.body !== "string") throw new Error("MOCK_EXPECTED_JSON_BODY");
		expect(JSON.parse(init.body)).toEqual({
			prompt: "A sailboat on a calm lake",
			locale: "en",
			semantic: "enforce",
		});
		return Response.json({
			data: {
				action: "allow",
				reasonCode: "allowed",
				requestId: "waffo_flow_mock",
				semanticStatus: "scored",
				matchedCategories: [],
			},
		});
	}
	if (url.hostname === "api.seeapi.com" && url.pathname === "/v1/inferences") {
		external.safetyCalls++;
		if (typeof init?.body !== "string") throw new Error("MOCK_EXPECTED_JSON_BODY");
		const payload = JSON.parse(init.body) as { endpoint: string; callback_url: string };
		const taskId = `seeapi_${crypto.randomUUID().replaceAll("-", "")}`;
		if (payload.endpoint === "image-moderation") {
			external.imageTasks.add(taskId);
			return Response.json({
				id: taskId,
				object: "inference",
				model: "nsfw-filter",
				endpoint: "image-moderation",
				provider: "seeapi",
				status: "queued",
				result: null,
				error: null,
			});
		}
		expect(payload.endpoint).toBe("video-moderation");
		external.visualTasks.add(taskId);
		const rawBody = JSON.stringify({ ignored: "body-is-not-authority" });
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = createHmac("sha256", "whsec_local_test_signing_secret_20261004")
			.update(`${timestamp}.${rawBody}`)
			.digest("hex");
		for (let repeat = 0; repeat < 2; repeat++)
			await acceptSeeapiVideoModerationWebhook(
				new Request(payload.callback_url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"X-SEEAPI-Timestamp": timestamp,
						"X-SEEAPI-Signature": `v1=${signature}`,
						"X-SEEAPI-Signing-Key": "whkey_test",
					},
					body: rawBody,
				}),
				{ environment: env, binding },
			);
		return Response.json(seeapiEnvelope(taskId, false));
	}
	if (url.hostname === "api.seeapi.com" && url.pathname.startsWith("/v1/inferences/")) {
		external.safetyCalls++;
		const taskId = url.pathname.split("/").at(-1)!;
		if (external.imageTasks.has(taskId))
			return Response.json({
				id: taskId,
				object: "inference",
				model: "nsfw-filter",
				endpoint: "image-moderation",
				provider: "seeapi",
				status: "succeeded",
				result: {
					type: "json",
					data: { flagged: false, categories: { nsfw: [], special_care: [] } },
				},
				error: null,
			});
		expect(external.visualTasks.has(taskId)).toBe(true);
		return Response.json(seeapiEnvelope(taskId, true));
	}
	throw new Error(`UNEXPECTED_EXTERNAL_REQUEST:${url.hostname}${url.pathname}`);
};

type Sample = {
	jobId: string;
	mode: string;
	concurrency: number;
	elapsedMs: number;
	stages: Record<string, number>;
	stageTimestamps: unknown;
	realProviderGenerationMs: null;
	realPlaybackMs: null;
};
const performanceRuns: Array<{
	concurrency: number;
	batches: number;
	elapsedMs: number;
	peakMockProviderCalls: number;
	p50Ms: number;
	p95Ms: number;
	samples: Sample[];
}> = [];
const samples: Sample[] = [];
const externalCounters = { providerMockCalls: 0, safetyMockCalls: 0 };
const percentile = (values: number[], fraction: number) =>
	[...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]!;

describe("video V1 actual-domain Mock end-to-end and measured concurrency", () => {
	let client: PrismaClient;
	let paidPlanId: string;
	let legacyActiveBaseline = 0;
	const ownerIds: string[] = [];
	beforeAll(async () => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("BLOCKED: isolated TEST_DATABASE_URL required");
		const url = new URL(connectionString);
		if (
			!["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
			!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1))
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 40 }) });
		// Serial image integration suites retain active fixtures in this isolated
		// database. Keep their real occupancy and add only this run's test slots.
		legacyActiveBaseline = await client.generationJob.count({
			where: {
				executionEngine: "legacy",
				terminalAt: null,
				status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] },
			},
		});
		paidPlanId = (
			await client.billingPlan.create({
				data: {
					provider: "paypal",
					providerPriceId: `video-flow-paid-${crypto.randomUUID()}`,
					name: "ISOLATED_FIXTURE_NOT_REAL_PAYMENT",
					creditsPerPeriod: 100n,
					priceMicros: 3_000_000n,
					currency: "USD",
					metadata: { evidence: "LOCAL_FIXTURE_ONLY" },
				},
			})
		).id;
		external.videoBytes = new Uint8Array(mp4Fixture({ mediaBytes: 64 * 1024, moovLast: true }));
		// Waffo's real signing/serialization wrapper also uses this network-only fixture.
		vi.stubGlobal("fetch", mockHttp);
	});
	afterEach(async () => {
		for (const ownerId of ownerIds.splice(0)) {
			const jobs = await client.generationJob.findMany({
				where: { ownerId },
				include: { reservation: true },
			});
			for (const job of jobs)
				if (job.reservation?.status === "ACTIVE") {
					await releaseCredits(
						{ reservationId: job.reservation.id, referenceKey: `flow-test-cleanup:${job.id}` },
						client,
					);
					await client.videoExecution.update({
						where: { jobId: job.id },
						data: { stage: "FAILED" },
					});
					await client.generationJob.update({
						where: { id: job.id },
						data: { status: "FAILED", terminalAt: new Date() },
					});
				}
		}
		externalCounters.providerMockCalls = external.paidMockCalls;
		externalCounters.safetyMockCalls = external.safetyCalls;
	});
	afterAll(async () => {
		if (process.env.VIDEO_V1_RUN_PERFORMANCE !== "1") {
			await client?.$disconnect();
			vi.unstubAllGlobals();
			return;
		}
		const output = fileURLToPath(
			new URL("../../../../.cache/video-v1/waffo-seeapi-performance.json", import.meta.url),
		);
		await mkdir(dirname(output), { recursive: true });
		await writeFile(
			output,
			JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					evidence: "LOCAL_NODE_MOCK_WITH_REAL_ISOLATED_POSTGRESQL_AND_DOMAIN_SERVICES",
					limitations: [
						"Workflow steps are an in-process deterministic harness; this is not Cloudflare latency",
						"Media is a synthetic MP4 metadata fixture, not a decoded or model-generated video",
						"Provider and moderation responses are fixtures; real cost and quality are unverified",
						"Test-only concurrency limits are raised directly in database service inputs; production config remains max 5",
						"Preexisting active legacy fixtures keep their shared-provider occupancy; only test capacity adds that measured baseline to the requested concurrency",
						"10 ms artificial provider response delay is used only to observe overlap",
						"Paid-funding eligibility runs against synthetic isolated billing rows; no real payment or revenue is represented",
					],
					externalPaidCalls: 0,
					legacyActiveBaseline,
					realProviderCostMicros: null,
					realModerationCostMicros: null,
					...externalCounters,
					performanceRuns,
					samples,
				},
				null,
				2,
			),
		);
		await client?.$disconnect();
		vi.unstubAllGlobals();
	});
	async function fixture(mode: "text-to-video" | "image-to-video") {
		const ownerId = `video-flow-test-${crypto.randomUUID()}`;
		ownerIds.push(ownerId);
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		const paymentId = crypto.randomUUID();
		const grantReferenceKey = `paypal-payment:${paymentId}:period:0:grant`;
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "paypal",
				providerSubscriptionId: paymentId,
				planId: paidPlanId,
				status: "ACTIVE",
			},
		});
		await client.billingPeriod.create({
			data: {
				subscriptionId: subscription.id,
				startsAt: new Date(Date.now() - 1000),
				endsAt: new Date(Date.now() + 86_400_000),
				status: "ACTIVE",
				creditAmount: 100n,
				grantReferenceKey,
				providerInvoiceId: paymentId,
				providerInvoicePaymentId: `paypal:${paymentId}`,
				paidAmount: 3_000_000n,
			},
		});
		await createCreditGrant(
			{ accountId: account.id, amount: 100n, referenceKey: grantReferenceKey },
			client,
		);
		let request: VideoRequestInput = {
			mode: "text-to-video",
			prompt: "A sailboat on a calm lake",
			duration: 5,
			sound: false,
			aspectRatio: "16:9",
		};
		if (mode === "image-to-video") {
			const asset = await client.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId,
					kind: "INPUT",
					verificationEngine: "video-workflow-v1",
					status: "VERIFYING",
					objectKey: `mock-input/${ownerId}.png`,
					mimeType: "image/png",
					byteSize: 100n,
					width: 100,
					height: 100,
					checksum: createHash("sha256").update(ownerId).digest("hex"),
					storageEtag: `mock-input-${ownerId}`,
					finalizedAt: new Date(),
				},
			});
			request = {
				mode,
				prompt: "A sailboat on a calm lake",
				duration: 5,
				sound: false,
				inputAssetId: asset.id,
			};
		}
		const quote = await createVideoQuoteRecord(
			{
				ownerId,
				request,
				price,
				visualSafetyProfile,
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				maximumInputBytes: 10_000_000,
			},
			client,
		);
		return { ownerId, request, quoteId: quote.quoteId, idempotencyKey: crypto.randomUUID() };
	}
	type Fixture = Awaited<ReturnType<typeof fixture>>;
	async function execute(fixture: Fixture, concurrency: number) {
		return runWithDatabaseClient(client, async () => {
			const start = performance.now();
			const stages: Record<string, number> = {};
			const admissionStarted = performance.now();
			const accepted = await createVideoJobRecord(
				{
					...fixture,
					price,
					visualSafetyProfile,
					textSafetyProfile: createVideoTextSafetyProfile(),
					audioSafetyPolicy: createVideoAudioSafetyPolicy(),
					paidFundingPolicy: { minimumUsdMicrosPerCredit: 21_944n },
					requestReceivedAt: new Date(),
					limits: {
						ownerConcurrency: 1,
						globalConcurrency: concurrency,
						providerConcurrency: legacyActiveBaseline + concurrency,
						maximumStorageBytes: 1_000_000_000n,
						maximumInputBytes: 10_000_000,
					},
				},
				client,
			);
			stages.admissionMs = performance.now() - admissionStarted;
			await ensureVideoWorkflowStarted(accepted.jobId, binding);
			const safety = createConfiguredVideoSafetyAdapter(env, { fetch: mockHttp });
			const provider = new KieVideoV1Adapter({ apiKey: "mock-only", fetch: mockHttp });
			const deps = {
				safety,
				provider,
				env,
				signRead: async (key: string) => `https://private.video.test/${encodeURIComponent(key)}`,
			};
			const steps: VideoDurableSteps = {
				async do(name, options, operation) {
					const at = performance.now();
					try {
						for (let retry = 0; ; retry++) {
							try {
								return await operation();
							} catch (error) {
								if (retry >= options.retries.limit) throw error;
							}
						}
					} finally {
						stages[name] ??= performance.now() - at;
					}
				},
				async waitForEvent() {
					throw new Error("SYNCHRONOUS_TERMINAL_MUST_NOT_SLEEP");
				},
				async sleep() {
					throw new Error("SYNCHRONOUS_TERMINAL_MUST_NOT_SLEEP");
				},
			};
			const services: VideoWorkflowServices = {
				checkpoint: getVideoWorkflowCheckpoint,
				window: (jobId, phase, round) =>
					getVideoWaitWindow({ jobId, phase, round, deadlineSeconds: 1800 }),
				reviewInput: (jobId) => reviewVideoInput(jobId, deps),
				submit: (jobId) => submitVideoAttempt(jobId, deps),
				confirm: (jobId) => confirmVideoProviderResult(jobId, deps),
				store: (jobId) => storeVideoOutput(jobId, env),
				reviewOutput: (jobId) =>
					runWithVideoWorkflowBinding(binding, () => reviewStoredVideo(jobId, env, safety)),
				finalize: finalizeVideoJob,
				fail: failVideoJob,
				needsReview: markVideoNeedsReview,
				providerPollSeconds: 30,
				moderationPollSeconds: 30,
			};
			expect(
				await runVideoGenerationV1({ jobId: accepted.jobId, schemaVersion: 1 }, steps, services),
			).toEqual({ completed: true, stage: "READY" });
			const readyElapsedMs = performance.now() - start;
			const job = await client.generationJob.findUniqueOrThrow({
				where: { id: accepted.jobId },
				include: { videoExecution: true, reservation: true, attempts: true },
			});
			expect(job.status).toBe("SUCCEEDED");
			expect(job.reservation?.status).toBe("SETTLED");
			expect(job.attempts).toHaveLength(1);
			expect(
				await client.creditLedgerEntry.count({
					where: { reservationId: job.reservation!.id, type: "SETTLE" },
				}),
			).toBe(1);
			expect(await client.outboxEvent.count({ where: { aggregateId: job.id } })).toBe(0);
			expect(await authorizeVideoPlayback(fixture.ownerId, job.id)).not.toBeNull();
			expect(await authorizeVideoPlayback("other-owner", job.id)).toBeNull();
			const acceptedCallback = external.tasks.get(job.attempts[0]!.providerTaskId!)!.callbackUrl;
			expect(
				await runVideoGenerationV1({ jobId: job.id, schemaVersion: 1 }, steps, services),
			).toEqual({ completed: true, stage: "READY" });
			await finalizeVideoJob(job.id);
			expect(
				[...external.tasks.values()].filter((task) => task.callbackUrl === acceptedCallback),
			).toHaveLength(1);
			expect(
				await client.creditLedgerEntry.count({
					where: { reservationId: job.reservation!.id, type: "SETTLE" },
				}),
			).toBe(1);
			const timestamps = Object.fromEntries(
				Object.entries(job.videoExecution!)
					.filter(([, value]) => value instanceof Date)
					.map(([name, value]) => [name, (value as Date).toISOString()]),
			);
			const data = job.videoExecution!.stageData as Record<string, unknown>;
			const recorded =
				data.timings && typeof data.timings === "object"
					? (data.timings as Record<string, unknown>)
					: {};
			for (const key of [
				"requestReceivedAt",
				"admissionTransactionStartedAt",
				"providerCapacityLockRequestedAt",
				"providerCapacityLockAcquiredAt",
				"creditReservationStartedAt",
				"creditReservationCompletedAt",
				"jobReservedAt",
				"jobReservationWrittenAt",
				"workflowCreateRequestedAt",
				"workflowStartedAt",
				"providerCallbackReceivedAt",
				"providerCallbackPersistedAt",
				"providerResultConfirmedAt",
			]) {
				const value = recorded[key];
				if (typeof value === "string" && Number.isFinite(Date.parse(value)))
					timestamps[key] = new Date(value).toISOString();
			}
			expect(Date.parse(timestamps.workflowCreateRequestedAt!)).toBeLessThanOrEqual(
				Date.parse(timestamps.workflowStartedAt!),
			);
			expect(Date.parse(timestamps.providerCallbackReceivedAt!)).toBeLessThanOrEqual(
				Date.parse(timestamps.providerCallbackPersistedAt!),
			);
			expect(Date.parse(timestamps.providerCallbackPersistedAt!)).toBeLessThanOrEqual(
				Date.parse(timestamps.providerResultConfirmedAt!),
			);
			const sample: Sample = {
				jobId: job.id,
				mode: fixture.request.mode,
				concurrency,
				elapsedMs: readyElapsedMs,
				stages,
				stageTimestamps: timestamps,
				realProviderGenerationMs: null,
				realPlaybackMs: null,
			};
			samples.push(sample);
			return sample;
		});
	}
	it.each(["text-to-video", "image-to-video"] as const)(
		"completes %s through real policies, SQL ledger and streamed immutable Mock storage",
		async (mode) => {
			const before = external.paidMockCalls;
			await execute(await fixture(mode), 1);
			expect(external.paidMockCalls - before).toBe(1);
			expect(
				external.requestedOutputs.every((url) => new URL(url).hostname === "cdn.video.test"),
			).toBe(true);
		},
	);
	it("recovers acceptance after a lost submission response using verified early callbacks without another paid submission", async () => {
		external.loseSubmitResponse = true;
		const before = external.paidMockCalls;
		await execute(await fixture("text-to-video"), 1);
		expect(external.paidMockCalls - before).toBe(1);
	});
	it.skipIf(process.env.VIDEO_V1_RUN_PERFORMANCE !== "1").each([5, 10, 20])(
		"measures %i concurrent isolated Mock flows without a shared heavy execution slot",
		async (concurrency) => {
			external.peakProviderCalls = 0;
			const batches = 10;
			const results: Sample[] = [];
			let elapsedMs = 0;
			for (let batch = 0; batch < batches; batch++) {
				// Account/grant setup is excluded from the measured admission burst.
				const fixtures: Fixture[] = [];
				for (let index = 0; index < concurrency; index++)
					fixtures.push(await fixture(index % 2 ? "image-to-video" : "text-to-video"));
				const started = performance.now();
				const paidBefore = external.paidMockCalls;
				const outcomes = await Promise.allSettled(
					fixtures.map((value) => execute(value, concurrency)),
				);
				for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
				results.push(
					...outcomes.map((outcome) => (outcome as PromiseFulfilledResult<Sample>).value),
				);
				expect(external.paidMockCalls - paidBefore).toBe(concurrency);
				elapsedMs += performance.now() - started;
			}
			performanceRuns.push({
				concurrency,
				batches,
				elapsedMs,
				peakMockProviderCalls: external.peakProviderCalls,
				p50Ms: percentile(
					results.map((value) => value.elapsedMs),
					0.5,
				),
				p95Ms: percentile(
					results.map((value) => value.elapsedMs),
					0.95,
				),
				samples: results,
			});
			expect(external.peakProviderCalls).toBeGreaterThan(1);
		},
		90_000,
	);
});
