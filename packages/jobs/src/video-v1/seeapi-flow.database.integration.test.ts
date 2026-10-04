import { createHash, createHmac, generateKeyPairSync, verify } from "node:crypto";
import { Readable } from "node:stream";

import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import {
	createCreditGrant,
	releaseCredits,
	reserveCreditsInTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { createVideoJobRecord, createVideoQuoteRecord } from "@repo/database/video-v1";
import { authorizeVideoPlayback } from "@repo/database/video-v1-fulfillment";
import {
	getVideoWaitWindow,
	getVideoWorkflowCheckpoint,
	markVideoNeedsReview,
} from "@repo/database/video-v1-recovery";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	runVideoGenerationV1,
	type VideoDurableSteps,
	type VideoWorkflowServices,
} from "../../../../apps/workflows/src/video-orchestrator";
import { mp4Fixture } from "../../../storage/test-support/video-fixture";
import { ensureVideoWorkflowStarted } from "./admission";
import type { AcceptedWebhookResult, VideoRequestInput, VideoWorkflowBinding } from "./contracts";
import { failVideoJob, finalizeVideoJob, reviewStoredVideo, storeVideoOutput } from "./fulfillment";
import { acceptSeeapiVideoModerationWebhook } from "./seeapi-webhooks";
import { confirmVideoProviderResult, reviewVideoInput, submitVideoAttempt } from "./submission";
import { seeapiEnvelope } from "./video-safety.test-fixtures";
import { runWithVideoWorkflowBinding } from "./workflow-binding";

// The domain services, serializers, moderation policies, immutable ledger and MP4
// inspector are real. Only external transport and private object primitives are fixtures.
const external = vi.hoisted(() => ({
	objects: new Map<string, { bytes: Uint8Array; etag: string }>(),
	parts: new Map<string, Map<number, Uint8Array>>(),
	videoBytes: new Uint8Array(),
	nextUpload: 0,
	providerCalls: 0,
	waffoPosts: 0,
	visualPosts: 0,
	visualGets: 0,
	sightengineVideoPosts: 0,
	asrPosts: 0,
	audioPosts: 0,
	loseVisualResponse: false,
	callbackMode: "deferred" as "deferred" | "early" | "missing" | "invalid",
	confirmationMode: "success" as
		| "success"
		| "http-error"
		| "retry-success"
		| "processing"
		| "invalid-response",
	callbackQueue: [] as string[],
	callbackResults: [] as AcceptedWebhookResult[],
	notifications: [] as Array<{ type: string; payload: Record<string, unknown> }>,
	waitTimeouts: [] as string[],
	sleeps: [] as string[],
	lastCallbackUrl: "",
	visualObjectKeys: [] as string[],
	audioObjectHashes: [] as string[],
	providerTasks: new Set<string>(),
	visualTasks: new Set<string>(),
	requestedSound: false,
}));
vi.mock("@repo/storage", async (original) => {
	const actual = await original<typeof import("@repo/storage")>();
	return {
		...actual,
		createSignedReadUrl: async ({ key }: { key: string }) =>
			`https://private.video.test/${encodeURIComponent(key)}`,
		abortIncompleteMultipartUploads: async () => 0,
		createMultipartUpload: async () => {
			const uploadId = `seeapi-flow-upload-${++external.nextUpload}`;
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
			external.parts.get(uploadId)!.set(partNumber, body.slice());
			return { partNumber, etag: `part-${partNumber}` };
		},
		completeMultipartUpload: async ({ uploadId, key }: { uploadId: string; key: string }) => {
			const bytes = Buffer.concat(
				[...external.parts.get(uploadId)!.entries()]
					.sort(([left], [right]) => left - right)
					.map(([, value]) => Buffer.from(value)),
			);
			external.objects.set(key, { bytes, etag: `immutable-${uploadId}` });
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
		) =>
			actual.requestRemoteMediaStream(url, {
				...options,
				resolve: async () => [{ address: "8.8.8.8", family: 4 as const }],
				request: async () => ({
					status: 200,
					headers: {
						"content-type": "video/mp4",
						"content-length": String(external.videoBytes.byteLength),
					},
					stream: Readable.from([external.videoBytes]),
				}),
			}),
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
	KIE_WEBHOOK_SECRET: "mock-only",
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
	pricingVersion: "SEEAPI_FLOW_TEST_ONLY",
	providerCostMicros: 2n,
	moderationCostMicros: 1n,
	pricingBasis: "SYNTHETIC_ISOLATED_TEST_NOT_A_FORMAL_PRICE",
};
const binding: VideoWorkflowBinding = {
	async create() {
		return this.get("mock-instance");
	},
	async get() {
		return {
			status: async () => ({ status: "running" }),
			sendEvent: async (event) => {
				external.notifications.push(event);
			},
		};
	},
};
async function deliverCallback(callbackUrl: string, valid = true) {
	// The signed body deliberately claims an unrelated ID/status. Only the URL
	// proof and the task stored before authenticated GET can authorize approval.
	const rawBody = JSON.stringify({
		id: "untrusted-body-task",
		status: "succeeded",
		result: { safe: true },
	});
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = valid
		? createHmac("sha256", "whsec_local_test_signing_secret_20261004")
				.update(`${timestamp}.${rawBody}`)
				.digest("hex")
		: "0".repeat(64);
	const result = await acceptSeeapiVideoModerationWebhook(
		new Request(callbackUrl, {
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
	external.callbackResults.push(result);
	return result;
}
const steps: VideoDurableSteps = {
	async do(_name, options, operation) {
		for (let retry = 0; ; retry++) {
			try {
				return await operation();
			} catch (error) {
				if (retry >= options.retries.limit) throw error;
			}
		}
	},
	async sleep(_name, duration) {
		expect(["1 seconds", "3 seconds"]).toContain(duration);
		external.sleeps.push(duration);
		await deliverCallback(external.lastCallbackUrl);
		await deliverCallback(external.lastCallbackUrl);
		await new Promise((resolve) => setTimeout(resolve, Number.parseInt(duration, 10) * 1000 + 20));
	},
	async waitForEvent(_name, options) {
		expect(options.type).toBe("moderation-result");
		expect(external.visualGets).toBe(0);
		external.waitTimeouts.push(options.timeout);
		expect(Number.parseInt(options.timeout, 10)).toBeGreaterThan(60);
		const callbackUrl = external.callbackQueue.shift();
		expect(callbackUrl).toBeDefined();
		if (external.callbackMode === "invalid") {
			await expect(deliverCallback(callbackUrl!, false)).rejects.toThrow(
				"VIDEO_SEEAPI_CALLBACK_UNAUTHORIZED",
			);
		} else if (external.callbackMode !== "missing") {
			await deliverCallback(callbackUrl!);
			await deliverCallback(callbackUrl!);
			return { type: "moderation-result" };
		}
		// Simulated durable deadline: no wall-clock delay and no real callback.
		throw Object.assign(new Error("MOCK_DURABLE_CALLBACK_DEADLINE"), {
			name: "WorkflowTimeoutError",
		});
	},
};

function jsonRequestBody(init?: RequestInit): unknown {
	if (typeof init?.body !== "string") throw new Error("MOCK_EXPECTED_JSON_BODY");
	return JSON.parse(init.body);
}
const mockHttp: typeof fetch = async (input, init) => {
	const url = new URL(
		typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
	);
	if (url.hostname === "api.waffo.ai" && url.pathname === "/v1/actions/verification/scan-prompt") {
		external.waffoPosts++;
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("manual");
		expect(jsonRequestBody(init)).toEqual({
			prompt: "A peaceful lake landscape",
			locale: "en",
			semantic: "enforce",
		});
		const headers = new Headers(init?.headers);
		expect(headers.get("x-merchant-id")).toBe(env.WAFFO_MERCHANT_ID);
		if (typeof init?.body !== "string") throw new Error("MOCK_EXPECTED_SIGNED_BODY");
		const bodyHash = createHash("sha256").update(init.body).digest("base64");
		const canonical = `POST\n/v1/actions/verification/scan-prompt\n${headers.get("x-timestamp")}\n${bodyHash}`;
		expect(
			verify(
				"RSA-SHA256",
				Buffer.from(canonical),
				fixtureKeys.publicKey,
				Buffer.from(headers.get("x-signature")!, "base64"),
			),
		).toBe(true);
		return Response.json({
			data: {
				action: "allow",
				reasonCode: "allowed",
				requestId: "waffo_mock_1",
				semanticStatus: "scored",
				matchedCategories: [],
			},
		});
	}
	if (url.hostname === "api.kie.ai" && url.pathname.endsWith("createTask")) {
		external.providerCalls++;
		const payload = jsonRequestBody(init) as {
			input: { duration: string; sound: boolean };
		};
		expect(payload.input.duration).toBe("5");
		expect(payload.input.sound).toBe(external.requestedSound);
		const taskId = `kie_mock_${crypto.randomUUID().replaceAll("-", "")}`;
		external.providerTasks.add(taskId);
		return Response.json({ code: 200, data: { taskId } });
	}
	if (url.hostname === "api.kie.ai" && url.pathname.endsWith("recordInfo")) {
		const taskId = url.searchParams.get("taskId")!;
		expect(external.providerTasks.has(taskId)).toBe(true);
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
	if (url.hostname === "api.seeapi.com" && url.pathname === "/v1/inferences") {
		external.visualPosts++;
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("manual");
		const payload = jsonRequestBody(init) as { input: { video_url: string }; callback_url: string };
		expect(payload).toEqual({
			model: "video-nsfw-filter",
			endpoint: "video-moderation",
			provider: "seeapi",
			callback_url: expect.any(String),
			input: {
				video_url: expect.any(String),
				num_frames: 8,
				threshold_offset: 0,
				strict_special_care: true,
				return_frames: "none",
			},
		});
		const key = decodeURIComponent(new URL(payload.input.video_url).pathname.slice(1));
		expect(external.objects.has(key)).toBe(true);
		external.visualObjectKeys.push(key);
		expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(
			/^video-v1:[^:]+:[a-f0-9]{64}$/,
		);
		const taskId = `seeapi_mock_${crypto.randomUUID().replaceAll("-", "")}`;
		external.visualTasks.add(taskId);
		external.lastCallbackUrl = payload.callback_url;
		if (external.callbackMode === "early") {
			await deliverCallback(payload.callback_url);
			await deliverCallback(payload.callback_url);
		} else external.callbackQueue.push(payload.callback_url);
		if (external.loseVisualResponse) throw new Error("MOCK_SEEAPI_RESPONSE_LOST_AFTER_ACCEPTANCE");
		return Response.json(seeapiEnvelope(taskId, false));
	}
	if (url.hostname === "api.seeapi.com" && url.pathname.startsWith("/v1/inferences/")) {
		expect(external.callbackResults[0]).toMatchObject({ accepted: true });
		external.visualGets++;
		const taskId = url.pathname.split("/").at(-1)!;
		expect(external.visualTasks.has(taskId)).toBe(true);
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer mock-only");
		if (
			external.confirmationMode === "http-error" ||
			(external.confirmationMode === "retry-success" && external.visualGets === 1)
		)
			return Response.json({ error: "MOCK_TEMPORARY_UNAVAILABLE" }, { status: 503 });
		if (external.confirmationMode === "processing")
			return Response.json(seeapiEnvelope(taskId, false));
		if (external.confirmationMode === "invalid-response")
			return Response.json(seeapiEnvelope("mismatched-task-id", true));
		return Response.json(seeapiEnvelope(taskId, true));
	}
	if (url.hostname === "api.sightengine.com") {
		external.sightengineVideoPosts++;
		throw new Error("RETIRED_PROVIDER_MUST_NOT_BE_CALLED");
	}
	if (url.hostname === "api.openai.com") {
		if (url.pathname === "/v1/audio/transcriptions") external.asrPosts++;
		else external.audioPosts++;
		throw new Error("AUDIO_REVIEW_NOT_REQUESTED_MUST_NOT_CALL_EXTERNAL_SERVICE");
	}
	throw new Error(`UNEXPECTED_EXTERNAL_REQUEST:${url.hostname}${url.pathname}`);
};

describe("SeeAPI visual actual-domain Mock flow", () => {
	let client: PrismaClient;
	let paidPlanId: string;
	const owners: string[] = [];
	beforeAll(async () => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.includes("test"))
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 8 }) });
		paidPlanId = (
			await client.billingPlan.create({
				data: {
					provider: "paypal",
					providerPriceId: `seeapi-flow-${crypto.randomUUID()}`,
					name: "ISOLATED_FIXTURE_NOT_REAL_PAYMENT",
					creditsPerPeriod: 100n,
					priceMicros: 3_000_000n,
					currency: "USD",
					metadata: {},
				},
			})
		).id;
	});
	beforeEach(() => {
		Object.assign(external, {
			providerCalls: 0,
			waffoPosts: 0,
			visualPosts: 0,
			visualGets: 0,
			sightengineVideoPosts: 0,
			asrPosts: 0,
			audioPosts: 0,
			loseVisualResponse: false,
			callbackMode: "deferred",
			confirmationMode: "success",
		});
		external.callbackQueue.length = 0;
		external.callbackResults.length = 0;
		external.notifications.length = 0;
		external.waitTimeouts.length = 0;
		external.sleeps.length = 0;
		external.lastCallbackUrl = "";
		external.visualObjectKeys.length = 0;
		external.audioObjectHashes.length = 0;
		vi.stubGlobal("fetch", mockHttp);
	});
	afterEach(async () => {
		for (const ownerId of owners.splice(0)) {
			const jobs = await client.generationJob.findMany({
				where: { ownerId },
				include: { reservation: true },
			});
			for (const job of jobs)
				if (job.reservation?.status === "ACTIVE") {
					await releaseCredits(
						{ reservationId: job.reservation.id, referenceKey: `seeapi-flow-cleanup:${job.id}` },
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
		vi.unstubAllGlobals();
	});
	afterAll(async () => client?.$disconnect());

	async function fixture(
		sound: boolean,
		provider: "seeapi" | "sightengine" = "seeapi",
		historicalAudio?: "required" | "missing",
	) {
		const ownerId = `seeapi-flow-test-${crypto.randomUUID()}`;
		owners.push(ownerId);
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
		const request: VideoRequestInput = {
			productKey: "video-kling-2-6-v1",
			mode: "text-to-video",
			prompt: "A peaceful lake landscape",
			duration: 5,
			sound,
			aspectRatio: "16:9",
			resolution: "default",
		};
		const visualSafetyProfile = createVideoVisualSafetyProfile(provider, request.duration);
		const quotedPrice = {
			...price,
			pricingDetails: {
				visualPolicyVersion: visualSafetyProfile.policyVersion,
				validUntil: new Date(Date.now() + 3600_000).toISOString(),
			},
		};
		const quote = await createVideoQuoteRecord(
			{
				ownerId,
				request,
				price: quotedPrice,
				visualSafetyProfile,
				textSafetyProfile: createVideoTextSafetyProfile(),
				audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				maximumInputBytes: 10_000_000,
			},
			client,
		);
		const legacyCount = await client.generationJob.count({
			where: {
				executionEngine: "legacy",
				terminalAt: null,
				status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] },
			},
		});
		const created = historicalAudio
			? await client.$transaction(async (tx) => {
					// Insert a synthetic pre-cutover row; never rewrite an admitted immutable snapshot.
					const baseline = await tx.generationQuote.findUniqueOrThrow({
						where: { id: quote.quoteId },
					});
					const { id: _id, createdAt: _at, ...fields } = baseline;
					const { audioSafetyPolicy: _policy, ...snapshot } = baseline.inputSnapshot as Record<
						string,
						unknown
					>;
					const inputSnapshot = {
						...snapshot,
						...(historicalAudio === "required"
							? { audioSafetyPolicy: { schemaVersion: 1, mode: "required" } }
							: {}),
					};
					const legacy = {
						...fields,
						inputSnapshot: inputSnapshot as never,
						pricingSnapshot: fields.pricingSnapshot as never,
					};
					const historicalQuote = await tx.generationQuote.create({
						data: {
							...legacy,
							inputFingerprint: fingerprintGenerationQuoteSecurityPayload(legacy),
						},
					});
					const job = await tx.generationJob.create({
						data: {
							ownerType: "USER",
							ownerId,
							submittedByUserId: ownerId,
							quoteId: historicalQuote.id,
							idempotencyKey: crypto.randomUUID(),
							productKey: historicalQuote.productKey,
							catalogVersion: historicalQuote.catalogVersion,
							pricingVersion: historicalQuote.pricingVersion,
							creditsReserved: historicalQuote.credits,
							executionEngine: "video-workflow-v1",
							inputSnapshot: historicalQuote.inputSnapshot as never,
							pricingSnapshot: historicalQuote.pricingSnapshot as never,
						},
					});
					await reserveCreditsInTransaction(
						{
							accountId: account.id,
							jobId: job.id,
							amount: historicalQuote.credits,
							referenceKey: `job:${job.id}:reserve`,
						},
						tx,
					);
					// Historical audio-policy fixtures still exercise a new paid claim,
					// so admission must already have reserved the complete output budget.
					await tx.storageUsageReservation.create({
						data: {
							ownerType: "USER",
							ownerId,
							referenceKey: `video-output:${job.id}`,
							bytes: 104857600n,
							expiresAt: new Date(Date.now() + 86_400_000),
						},
					});
					await tx.videoExecution.create({
						data: {
							jobId: job.id,
							workflowInstanceId: `video-v1-${job.id}`,
							modelContractVersion: historicalQuote.catalogVersion,
							stage: "QUEUED",
							startState: "PENDING",
						},
					});
					return { jobId: job.id, replayed: false };
				})
			: await createVideoJobRecord(
					{
						ownerId,
						request,
						quoteId: quote.quoteId,
						idempotencyKey: crypto.randomUUID(),
						price: quotedPrice,
						visualSafetyProfile,
						textSafetyProfile: createVideoTextSafetyProfile(),
						audioSafetyPolicy: createVideoAudioSafetyPolicy(),
						paidFundingPolicy: { minimumUsdMicrosPerCredit: 21_944n },
						limits: {
							ownerConcurrency: 1,
							globalConcurrency: 5,
							providerConcurrency: legacyCount + 5,
							maximumStorageBytes: 1_000_000_000n,
							maximumInputBytes: 10_000_000,
						},
					},
					client,
				);
		external.requestedSound = sound;
		external.videoBytes = new Uint8Array(
			mp4Fixture({ audio: sound, mediaBytes: 64 * 1024, moovLast: true }),
		);
		return { ...created, ownerId, accountId: account.id, visualSafetyProfile };
	}
	function services(environment: Record<string, string | undefined>): VideoWorkflowServices {
		return {
			checkpoint: getVideoWorkflowCheckpoint,
			window: (jobId, phase, round) =>
				getVideoWaitWindow({ jobId, phase, round, deadlineSeconds: 1800 }),
			reviewInput: (jobId) => reviewVideoInput(jobId, { env: environment }),
			submit: (jobId) => submitVideoAttempt(jobId, { env: environment }),
			confirm: (jobId) => confirmVideoProviderResult(jobId, { env: environment }),
			store: (jobId) => storeVideoOutput(jobId, environment),
			reviewOutput: (jobId) =>
				runWithVideoWorkflowBinding(binding, () => reviewStoredVideo(jobId, environment)),
			finalize: finalizeVideoJob,
			fail: failVideoJob,
			needsReview: markVideoNeedsReview,
			providerPollSeconds: 30,
			moderationPollSeconds: 30,
		};
	}
	async function stored(jobId: string) {
		return client.generationJob.findUniqueOrThrow({
			where: { id: jobId },
			include: {
				videoExecution: true,
				reservation: true,
				attempts: true,
				assets: { include: { asset: { include: { moderationResults: true } } } },
			},
		});
	}
	it.each([false, true])(
		"completes SeeAPI visual review with native sound=%s and immutable private evidence",
		async (sound) => {
			await runWithDatabaseClient(client, async () => {
				const f = await fixture(sound);
				external.callbackMode = sound ? "early" : "deferred";
				// Mutable environment selection cannot rewrite the admitted visual profile.
				const executionEnv = {
					...env,
					VIDEO_V1_VIDEO_SAFETY_ADAPTER: sound ? "unconfigured-future-provider" : "seeapi",
				};
				await ensureVideoWorkflowStarted(f.jobId, binding);
				expect(
					await runVideoGenerationV1(
						{ jobId: f.jobId, schemaVersion: 1 },
						steps,
						services(executionEnv),
					),
				).toEqual({ completed: true, stage: "READY" });
				const job = await stored(f.jobId);
				const asset = job.assets[0]!.asset;
				expect(job.reservation?.status).toBe("SETTLED");
				expect(job.attempts).toHaveLength(1);
				expect(job.inputSnapshot).toMatchObject({
					visualSafetyProfile: f.visualSafetyProfile,
					textSafetyProfile: createVideoTextSafetyProfile(),
					audioSafetyPolicy: createVideoAudioSafetyPolicy(),
				});
				expect(asset.moderationResults).toHaveLength(1);
				expect(asset.moderationResults[0]).toMatchObject({
					provider: "seeapi",
					status: "APPROVED",
					assetChecksum: asset.checksum,
					policyVersion: f.visualSafetyProfile.policyVersion,
				});
				expect(asset.moderationResults[0]!.rawEnvelope).toMatchObject({
					objectEtag: asset.storageEtag,
					visualSafetyProfile: f.visualSafetyProfile,
					audioSafetyPolicy: createVideoAudioSafetyPolicy(),
					seeapiVideo: { checkedFrames: 8, thresholdOffset: 0, strictSpecialCare: true },
				});
				expect(external.visualObjectKeys).toEqual([asset.objectKey]);
				expect(external.audioObjectHashes).toEqual([]);
				expect(job.videoExecution!.stageData).not.toHaveProperty("audioReview");
				expect(asset.moderationResults[0]!.rawEnvelope).not.toHaveProperty("audio");
				expect(external.asrPosts).toBe(0);
				expect(external.audioPosts).toBe(0);
				expect(external.waffoPosts).toBe(1);
				expect(external.visualPosts).toBe(1);
				expect(external.visualGets).toBe(1);
				expect(
					external.callbackResults.map(({ accepted, replayed }) => ({ accepted, replayed })),
				).toEqual([
					{ accepted: true, replayed: false },
					{ accepted: true, replayed: true },
				]);
				expect(external.notifications).toHaveLength(1);
				expect(external.notifications[0]).toMatchObject({
					type: "moderation-result",
					payload: { jobId: f.jobId },
				});
				expect(external.waitTimeouts).toHaveLength(sound ? 0 : 1);
				expect(external.sleeps).toEqual([]);
				const callbacks = await client.providerWebhookEvent.findMany({
					where: { provider: "seeapi-video-v1", envelope: { path: ["jobId"], equals: f.jobId } },
				});
				expect(callbacks).toHaveLength(1);
				expect(callbacks[0]).toMatchObject({
					status: "PROCESSED",
					providerTaskId: asset.verificationProviderTaskId,
					envelope: {
						jobId: f.jobId,
						assetId: asset.id,
						checksum: asset.checksum,
						etag: asset.storageEtag,
						rawBody: JSON.stringify({
							id: "untrusted-body-task",
							status: "succeeded",
							result: { safe: true },
						}),
					},
				});
				expect(job.videoExecution!.stageData).toMatchObject({
					seeapiVisualReview: {
						phase: "COMPLETE",
						providerTaskId: asset.verificationProviderTaskId,
						checksum: asset.checksum,
						etag: asset.storageEtag,
						decision: { decision: "ALLOW" },
					},
				});
				expect(external.sightengineVideoPosts).toBe(0);
				expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).not.toBeNull();
				expect(await authorizeVideoPlayback("other-owner", f.jobId)).toBeNull();
				await runVideoGenerationV1(
					{ jobId: f.jobId, schemaVersion: 1 },
					steps,
					services(executionEnv),
				);
				await finalizeVideoJob(f.jobId);
				expect(external.providerCalls).toBe(1);
				expect(external.visualPosts).toBe(1);
				expect(
					await client.creditLedgerEntry.count({
						where: { accountId: f.accountId, type: "SETTLE" },
					}),
				).toBe(1);
				expect(await client.outboxEvent.count({ where: { aggregateId: f.jobId } })).toBe(0);
			});
		},
	);
	it.each(["missing", "invalid"] as const)(
		"holds on %s callback deadline with zero visual GETs",
		async (callbackMode) => {
			await runWithDatabaseClient(client, async () => {
				const f = await fixture(false);
				external.callbackMode = callbackMode;
				expect(
					await runVideoGenerationV1({ jobId: f.jobId, schemaVersion: 1 }, steps, services(env)),
				).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
				const job = await stored(f.jobId);
				expect(job.videoExecution).toMatchObject({
					needsReviewReason: "OUTPUT_REVIEW_CALLBACK_DEADLINE",
				});
				expect(job.reservation?.status).toBe("ACTIVE");
				expect(external.providerCalls).toBe(1);
				expect(external.visualPosts).toBe(1);
				expect(external.visualGets).toBe(0);
				expect(external.waitTimeouts).toHaveLength(1);
				expect(external.sleeps).toEqual([]);
				expect(external.callbackResults).toEqual([]);
				expect(
					await client.providerWebhookEvent.count({
						where: { provider: "seeapi-video-v1", envelope: { path: ["jobId"], equals: f.jobId } },
					}),
				).toBe(0);
				expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).toBeNull();
				expect(
					await client.creditLedgerEntry.count({
						where: { accountId: f.accountId, type: "SETTLE" },
					}),
				).toBe(0);
			});
		},
	);
	it.each(["http-error", "processing", "invalid-response"] as const)(
		"holds a %s confirmation without another paid POST or generation",
		async (confirmationMode) => {
			await runWithDatabaseClient(client, async () => {
				const f = await fixture(false);
				external.confirmationMode = confirmationMode;
				expect(
					await runVideoGenerationV1({ jobId: f.jobId, schemaVersion: 1 }, steps, services(env)),
				).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
				const job = await stored(f.jobId);
				expect(job.reservation?.status).toBe("ACTIVE");
				expect(external.providerCalls).toBe(1);
				expect(external.visualPosts).toBe(1);
				expect(external.visualGets).toBe(confirmationMode === "http-error" ? 3 : 1);
				expect(external.sleeps).toEqual(
					confirmationMode === "http-error" ? ["1 seconds", "3 seconds"] : [],
				);
				expect(external.waitTimeouts).toHaveLength(1);
				expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).toBeNull();
				expect(
					await client.creditLedgerEntry.count({
						where: { accountId: f.accountId, type: "SETTLE" },
					}),
				).toBe(0);
				await expect(reviewStoredVideo(f.jobId, env)).rejects.toThrow("VIDEO_REVIEW_TERMINAL");
				expect(external.visualGets).toBe(confirmationMode === "http-error" ? 3 : 1);
			});
		},
	);
	it("recovers one temporary GET failure with the same task and unchanged callback budget", async () => {
		await runWithDatabaseClient(client, async () => {
			const f = await fixture(false);
			external.confirmationMode = "retry-success";
			expect(
				await runVideoGenerationV1({ jobId: f.jobId, schemaVersion: 1 }, steps, services(env)),
			).toEqual({ completed: true, stage: "READY" });
			expect(external.providerCalls).toBe(1);
			expect(external.visualPosts).toBe(1);
			expect(external.visualGets).toBe(2);
			expect(external.sleeps).toEqual(["1 seconds"]);
			expect(external.callbackResults.filter((result) => !result.replayed)).toHaveLength(1);
			expect(
				external.callbackResults.filter((result) => result.replayed).length,
			).toBeGreaterThanOrEqual(3);
			expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).not.toBeNull();
			expect(
				await client.creditLedgerEntry.count({ where: { accountId: f.accountId, type: "SETTLE" } }),
			).toBe(1);
		});
	});
	it.each(["required", "missing"] as const)(
		"keeps historical %s audio-review policy on hold without silently downgrading it",
		async (historicalAudio) => {
			await runWithDatabaseClient(client, async () => {
				const f = await fixture(true, "seeapi", historicalAudio);
				expect(
					await runVideoGenerationV1({ jobId: f.jobId, schemaVersion: 1 }, steps, services(env)),
				).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
				const job = await stored(f.jobId);
				expect(job.videoExecution).toMatchObject({
					needsReviewReason: "VIDEO_AUDIO_REVIEW_NOT_ENABLED",
				});
				expect(job.reservation?.status).toBe("ACTIVE");
				if (historicalAudio === "required")
					expect(job.inputSnapshot).toMatchObject({
						audioSafetyPolicy: { schemaVersion: 1, mode: "required" },
					});
				else expect(job.inputSnapshot).not.toHaveProperty("audioSafetyPolicy");
				expect(external.providerCalls).toBe(1);
				expect(external.visualPosts).toBe(0);
				expect(external.visualGets).toBe(0);
				expect(external.asrPosts).toBe(0);
				expect(external.audioPosts).toBe(0);
				expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).toBeNull();
			});
		},
	);
	it("holds a frozen retired Sightengine profile without calling either visual provider", async () => {
		await runWithDatabaseClient(client, async () => {
			const f = await fixture(false, "sightengine");
			expect(
				await runVideoGenerationV1({ jobId: f.jobId, schemaVersion: 1 }, steps, services(env)),
			).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
			expect((await stored(f.jobId)).videoExecution).toMatchObject({
				needsReviewReason: "MODERATION_PROVIDER_RETIRED",
			});
			expect(external.sightengineVideoPosts).toBe(0);
			expect(external.visualPosts).toBe(0);
			expect(external.visualGets).toBe(0);
			expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).toBeNull();
		});
	});
	it("retains reservation and review fence after a lost SeeAPI submit response without re-POST or regeneration", async () => {
		await runWithDatabaseClient(client, async () => {
			const f = await fixture(false);
			external.loseVisualResponse = true;
			expect(
				await runVideoGenerationV1({ jobId: f.jobId, schemaVersion: 1 }, steps, services(env)),
			).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
			const job = await stored(f.jobId);
			expect(job.reservation?.status).toBe("ACTIVE");
			expect(job.assets[0]!.asset).toMatchObject({
				verificationSubmissionUncertain: true,
				verificationProviderTaskId: null,
			});
			expect(job.videoExecution).toMatchObject({
				needsReviewReason: "VIDEO_MODERATION_SUBMISSION_UNCERTAIN",
			});
			await expect(reviewStoredVideo(f.jobId, env)).rejects.toThrow("VIDEO_REVIEW_TERMINAL");
			expect(external.providerCalls).toBe(1);
			expect(external.visualPosts).toBe(1);
			expect(external.visualGets).toBe(0);
			expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).toBeNull();
			expect(
				await client.creditLedgerEntry.count({ where: { accountId: f.accountId, type: "SETTLE" } }),
			).toBe(0);
		});
	});
});
