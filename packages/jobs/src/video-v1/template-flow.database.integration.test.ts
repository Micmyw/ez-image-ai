import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import { createConfiguredVideoSafetyAdapter } from "@repo/ai/media/moderation/video-configured";
import { KieTemplateSceneAdapter } from "@repo/ai/media/providers/kie-template-scene";
import { KieVideoModelsAdapter } from "@repo/ai/media/providers/kie-video-models";
import type { VideoEffectRequest } from "@repo/config/video-effects";
import { createVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { createCreditGrant, releaseCredits } from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import {
	createVideoTemplateJobRecord,
	createVideoTemplateQuoteRecord,
} from "@repo/database/video-template-admission";
import * as templateDatabase from "@repo/database/video-template-execution";
import { failVideoExecution } from "@repo/database/video-v1-execution";
import { authorizeVideoPlayback, failVideoDelivery } from "@repo/database/video-v1-fulfillment";
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
import type { VideoWorkflowBinding } from "./contracts";
import { failVideoJob, finalizeVideoJob, reviewStoredVideo, storeVideoOutput } from "./fulfillment";
import { acceptSeeapiVideoModerationWebhook } from "./seeapi-webhooks";
import { confirmVideoProviderResult, reviewVideoInput, submitVideoAttempt } from "./submission";
import {
	prepareVideoTemplate,
	type VideoTemplatePreparationDependencies,
} from "./template-preparation";
import { seeapiEnvelope } from "./video-safety.test-fixtures";
import { runWithVideoWorkflowBinding } from "./workflow-binding";

// Real SQL admission, immutable snapshots, paid fences, Workflow branch, ledger and final
// MP4 verification. Only external provider HTTP, moderation HTTP and storage are fixtures.
// The MP4 fixture contains synthetic metadata; it is not a model sample or playback proof.
const external = vi.hoisted(() => ({
	objects: new Map<string, { bytes: Uint8Array; etag: string }>(),
	parts: new Map<string, Map<number, Uint8Array>>(),
	videoBytes: new Uint8Array(),
	requestedOutputs: [] as string[],
	outputReads: [] as string[],
	nextUpload: 0,
	paidMockCalls: 0,
	sceneCalls: 0,
	sceneStoreCalls: 0,
	loseSceneResponse: false,
	sceneRejected: false,
	textPrompts: [] as string[],
	sceneRequests: [] as Array<Record<string, unknown>>,
	videoRequests: [] as Array<Record<string, unknown>>,
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
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
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
	pricingDetails: { validUntil: new Date(Date.now() + 3600_000).toISOString() },
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

const mockHttp: typeof fetch = async (input, init) => {
	const url = new URL(
		typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
	);
	if (url.hostname === "api.kie.ai" && url.pathname.endsWith("createTask")) {
		if (typeof init?.body !== "string") throw new Error("MOCK_EXPECTED_JSON_BODY");
		const body = JSON.parse(init.body) as {
			model: string;
			callBackUrl: string;
			input: Record<string, unknown>;
		};
		const isScene = body.model === "nano-banana-2-lite";
		if (isScene) {
			external.sceneCalls++;
			external.sceneRequests.push(body.input);
			expect(body.input.image_urls).toHaveLength(2);
			expect(body.callBackUrl).toContain("/api/webhooks/video-template/kie/");
			if (external.sceneRejected) return Response.json({ code: 422 });
		} else {
			external.paidMockCalls++;
			external.videoRequests.push(body.input);
			expect(body.model).toBe("bytedance/seedance-1.5-pro");
			expect(body.input).toMatchObject({
				duration: 5,
				resolution: "720p",
				aspect_ratio: "9:16",
				generate_audio: false,
				fixed_lens: true,
			});
			expect(body.input.input_urls).toHaveLength(1);
		}
		const taskId = `${isScene ? "scene" : "video"}_${crypto.randomUUID().replaceAll("-", "")}`;
		external.tasks.set(taskId, { callbackUrl: body.callBackUrl });
		if (isScene && external.loseSceneResponse) throw new Error("SCENE_ACCEPTED_RESPONSE_LOST");
		if (!isScene && external.loseSubmitResponse) throw new Error("VIDEO_ACCEPTED_RESPONSE_LOST");
		return Response.json({ code: 200, data: { taskId } });
	}
	if (url.hostname === "api.kie.ai" && url.pathname.endsWith("recordInfo")) {
		const taskId = url.searchParams.get("taskId")!;
		if (!external.tasks.has(taskId)) throw new Error("UNEXPECTED_PROVIDER_TASK");
		return Response.json({
			code: 200,
			data: {
				taskId,
				state: "success",
				resultJson: JSON.stringify({
					resultUrls: [
						`https://cdn.video.test/${taskId}.${taskId.startsWith("scene_") ? "png" : "mp4"}`,
					],
				}),
				creditsConsumed: 123,
				completeTime: Date.now(),
			},
		});
	}
	if (url.hostname === "api.waffo.ai" && url.pathname === "/v1/actions/verification/scan-prompt") {
		external.safetyCalls++;
		if (typeof init?.body !== "string") throw new Error("MOCK_EXPECTED_JSON_BODY");
		external.textPrompts.push((JSON.parse(init.body) as { prompt: string }).prompt);
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
	name: string;
	elapsedMs: number;
	stages: Record<string, number>;
	jobId: string;
	externalPaidCalls: 0;
};
const samples: Sample[] = [];
describe("Hotel Lobby template real SQL and mocked external lifecycle", () => {
	let client: PrismaClient;
	let paidPlanId: string;
	let activeBaseline: number;
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
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 10 }) });
		activeBaseline = await client.generationJob.count({
			where: { terminalAt: null, status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] } },
		});
		paidPlanId = (
			await client.billingPlan.create({
				data: {
					provider: "paypal",
					providerPriceId: `hotel-template-fixture-${crypto.randomUUID()}`,
					name: "SYNTHETIC_LOCAL_PAID_FUNDING_ONLY",
					creditsPerPeriod: 100n,
					priceMicros: 3_000_000n,
					currency: "USD",
					metadata: { evidence: "LOCAL_FIXTURE_ONLY" },
				},
			})
		).id;
		external.videoBytes = new Uint8Array(
			mp4Fixture({ width: 720, height: 1280, mediaBytes: 32 * 1024, moovLast: true }),
		);
		vi.stubGlobal("fetch", mockHttp);
	});
	afterEach(async () => {
		external.loseSceneResponse = false;
		external.loseSubmitResponse = false;
		external.sceneRejected = false;
		// Fixture-only cleanup never invokes production recovery or touches other owners.
		// An intentionally ambiguous fixture keeps its reservation until all assertions finish.
		for (const ownerId of ownerIds.splice(0)) {
			const jobs = await client.generationJob.findMany({
				where: { ownerId },
				include: { reservation: true },
			});
			for (const job of jobs)
				if (job.reservation?.status === "ACTIVE") {
					await releaseCredits(
						{
							reservationId: job.reservation.id,
							referenceKey: `template-fixture-cleanup:${job.id}`,
						},
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
	});
	afterAll(async () => {
		vi.unstubAllGlobals();
		await client?.$disconnect();
		const output = fileURLToPath(
			new URL("../../../../.cache/hotel-lobby/template-flow-local.json", import.meta.url),
		);
		await mkdir(dirname(output), { recursive: true });
		await writeFile(
			output,
			JSON.stringify(
				{
					evidence: "LOCAL_POSTGRES_DOMAIN_WORKFLOW_WITH_MOCKED_EXTERNAL_TRANSPORT",
					generatedAt: new Date().toISOString(),
					externalPaidCalls: 0,
					limitations: [
						"Not Cloudflare execution or provider latency",
						"Synthetic MP4 metadata is not a decodable sample or visual-quality evidence",
						"Scene byte storage/normalization is separately unit tested; this suite injects its result",
						"Funding is synthetic test billing, not real revenue",
					],
					samples,
				},
				null,
				2,
			),
		);
	});

	async function fixture(effectId: VideoEffectRequest["effectId"] = "hotel-lobby-duo") {
		const ownerId = `hotel-flow-test-${crypto.randomUUID()}`;
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
		const inputs = await Promise.all(
			["left", "right"].map((role) =>
				client.mediaAsset.create({
					data: {
						ownerType: "USER",
						ownerId,
						kind: "INPUT",
						verificationEngine: "video-workflow-v1",
						status: "VERIFYING",
						objectKey: `users/${ownerId}/${role}.template-source.template-input.png`,
						mimeType: "image/png",
						byteSize: 100n,
						width: 576,
						height: 1024,
						checksum: createHash("sha256").update(`${ownerId}:${role}`).digest("hex"),
						storageEtag: `fixture-${ownerId}-${role}`,
						finalizedAt: new Date(),
					},
				}),
			),
		);
		if (effectId === "raindance-solo") inputs[1] = inputs[0]!;
		const request: VideoEffectRequest = {
			effectId,
			presetKey: "standard",
			inputs: { leftAssetId: inputs[0]!.id, rightAssetId: inputs[1]!.id },
		};
		const template = createVideoEffectTemplateSnapshot(request);
		const profile = {
			price,
			visualSafetyProfile,
			textSafetyProfile: createVideoTextSafetyProfile(),
			audioSafetyPolicy: createVideoAudioSafetyPolicy(),
		};
		const quote = await createVideoTemplateQuoteRecord(
			{ ownerId, request, template, ...profile, maximumInputBytes: 10_000_000 },
			client,
		);
		const accepted = await createVideoTemplateJobRecord(
			{
				ownerId,
				request,
				template,
				...profile,
				quoteId: quote.quoteId,
				idempotencyKey: crypto.randomUUID(),
				paidFundingPolicy: { minimumUsdMicrosPerCredit: 21_944n },
				requestReceivedAt: new Date(),
				limits: {
					ownerConcurrency: 1,
					globalConcurrency: activeBaseline + 10,
					providerConcurrency: activeBaseline + 10,
					maximumStorageBytes: 1_000_000_000n,
					maximumInputBytes: 10_000_000,
				},
			},
			client,
		);
		const parent = await client.generationJob.findUniqueOrThrow({
			where: { id: accepted.jobId },
			include: { reservation: true },
		});
		return {
			ownerId,
			jobId: accepted.jobId,
			template,
			inputs,
			parentSnapshot: parent.inputSnapshot,
			reservationId: parent.reservation!.id,
		};
	}
	type Fixture = Awaited<ReturnType<typeof fixture>>;
	function dependencies(overrides: Partial<VideoTemplatePreparationDependencies> = {}) {
		const safety = createConfiguredVideoSafetyAdapter(env, { fetch: mockHttp });
		const shared = {
			safety,
			env,
			signRead: async (key: string) => `https://private.video.test/${encodeURIComponent(key)}`,
		};
		const preparation: Partial<VideoTemplatePreparationDependencies> = {
			...shared,
			provider: new KieTemplateSceneAdapter({ apiKey: "mock-only", fetch: mockHttp }),
			storeScene: async ({ key }) => {
				expect(key).toMatch(/^users\//);
				external.sceneStoreCalls++;
				const bytes = new TextEncoder().encode("LOCAL_SYNTHETIC_SCENE_FIXTURE_NOT_AN_IMAGE");
				external.objects.set(key, { bytes, etag: "immutable-scene-fixture-etag" });
				return {
					bytes: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					etag: "immutable-scene-fixture-etag",
					versionId: null,
					width: 576,
					height: 1024,
				};
			},
			...overrides,
		};
		return {
			safety,
			preparation,
			video: {
				...shared,
				provider: new KieVideoModelsAdapter({ apiKey: "mock-only", fetch: mockHttp }),
			},
		};
	}
	async function execute(
		f: Fixture,
		name: string,
		preparationOverrides: Partial<VideoTemplatePreparationDependencies> = {},
	) {
		const start = performance.now();
		const stages: Record<string, number> = {};
		const deps = dependencies(preparationOverrides);
		await ensureVideoWorkflowStarted(f.jobId, binding);
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
					stages[name] = (stages[name] ?? 0) + performance.now() - at;
				}
			},
			async waitForEvent() {
				throw new Error("SYNCHRONOUS_FIXTURE_MUST_NOT_SLEEP");
			},
			async sleep() {
				throw new Error("SYNCHRONOUS_FIXTURE_MUST_NOT_SLEEP");
			},
		};
		const services: VideoWorkflowServices = {
			checkpoint: getVideoWorkflowCheckpoint,
			window: (jobId, phase, round) =>
				getVideoWaitWindow({ jobId, phase, round, deadlineSeconds: 1800 }),
			prepareTemplate: (jobId) => prepareVideoTemplate(jobId, deps.preparation),
			reviewInput: (jobId) => reviewVideoInput(jobId, deps.video),
			submit: (jobId) => submitVideoAttempt(jobId, deps.video),
			confirm: (jobId) => confirmVideoProviderResult(jobId, deps.video),
			store: (jobId) => storeVideoOutput(jobId, env),
			reviewOutput: (jobId) =>
				runWithVideoWorkflowBinding(binding, () => reviewStoredVideo(jobId, env, deps.safety)),
			finalize: finalizeVideoJob,
			fail: failVideoJob,
			needsReview: markVideoNeedsReview,
			providerPollSeconds: 30,
			moderationPollSeconds: 30,
		};
		const result = await runVideoGenerationV1(
			{ jobId: f.jobId, schemaVersion: 1 },
			steps,
			services,
		);
		samples.push({
			name,
			elapsedMs: performance.now() - start,
			stages,
			jobId: f.jobId,
			externalPaidCalls: 0,
		});
		return {
			result,
			repeat: () => runVideoGenerationV1({ jobId: f.jobId, schemaVersion: 1 }, steps, services),
		};
	}
	async function assertReady(f: Fixture) {
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: f.jobId },
			include: {
				videoExecution: true,
				videoTemplateExecution: { include: { sceneAsset: true } },
				reservation: true,
				attempts: true,
				assets: { include: { asset: true } },
			},
		});
		expect(job.inputSnapshot).toEqual(f.parentSnapshot);
		expect(job.status).toBe("SUCCEEDED");
		expect(job.videoExecution?.stage).toBe("READY");
		expect(job.reservation?.status).toBe("SETTLED");
		expect(job.reservation?.amount).toBe(price.credits);
		expect(job.reservation?.settledAmount).toBe(price.credits);
		expect(job.attempts).toHaveLength(1);
		const sidecar = job.videoTemplateExecution!;
		expect(sidecar.sceneAsset?.kind).toBe("INPUT");
		expect(sidecar.resolvedInputIdentity).not.toBeNull();
		const finalOutputs = job.assets.filter((binding) => binding.role === "OUTPUT");
		expect(finalOutputs).toHaveLength(1);
		expect(finalOutputs[0]!.asset.id).not.toBe(sidecar.sceneAssetId);
		expect(finalOutputs[0]!.asset.mimeType).toBe("video/mp4");
		expect(finalOutputs[0]!.asset.width).toBe(720);
		expect(finalOutputs[0]!.asset.height).toBe(1280);
		expect(job.attempts[0]!.requestSnapshot).toMatchObject({
			requestFingerprint: (f.parentSnapshot as Record<string, unknown>).requestFingerprint,
			inputAssetId: sidecar.sceneAssetId,
			inputIdentity: {
				assetId: sidecar.sceneAssetId,
				checksum: sidecar.sceneAsset!.checksum,
				storageEtag: sidecar.sceneAsset!.storageEtag,
			},
		});
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(
			await client.creditReservation.count({ where: { accountId: job.reservation!.accountId } }),
		).toBe(1);
		expect(
			await client.creditLedgerEntry.count({
				where: { reservationId: f.reservationId, type: "SETTLE" },
			}),
		).toBe(1);
		expect(await client.outboxEvent.count({ where: { aggregateId: f.jobId } })).toBe(0);
		const playable = await authorizeVideoPlayback(f.ownerId, f.jobId);
		expect(playable?.id).toBe(finalOutputs[0]!.asset.id);
		expect(await authorizeVideoPlayback("different-owner", f.jobId)).toBeNull();
		return job;
	}
	it.each(["raindance-solo", "raindance-duo"] as const)(
		"settles %s once through the complete existing Workflow with private playback",
		async (effectId) =>
			runWithDatabaseClient(client, async () => {
				const f = await fixture(effectId);
				const before = { scene: external.sceneCalls, video: external.paidMockCalls };
				const flow = await execute(f, `${effectId}-complete-and-replay`);
				expect(flow.result).toEqual({ completed: true, stage: "READY" });
				await assertReady(f);
				expect(external.sceneRequests.at(-1)?.image_urls).toEqual(
					f.inputs.map(
						(asset) => `https://private.video.test/${encodeURIComponent(asset.objectKey)}`,
					),
				);
				expect(await flow.repeat()).toEqual({ completed: true, stage: "READY" });
				await assertReady(f);
				expect(external.sceneCalls - before.scene).toBe(1);
				expect(external.paidMockCalls - before.video).toBe(1);
			}),
	);

	it("advances both ordered inputs through the existing Workflow, seals one scene, and settles only the final private MP4 once", async () =>
		runWithDatabaseClient(client, async () => {
			const f = await fixture();
			const before = {
				scene: external.sceneCalls,
				video: external.paidMockCalls,
				sceneStore: external.sceneStoreCalls,
				images: external.imageTasks.size,
				texts: external.textPrompts.length,
			};
			expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).toBeNull();
			const flow = await execute(f, "complete-and-replay");
			expect(flow.result).toEqual({ completed: true, stage: "READY" });
			const ready = await assertReady(f);
			expect(external.sceneRequests.at(-1)?.image_urls).toEqual(
				f.inputs.map(
					(asset) => `https://private.video.test/${encodeURIComponent(asset.objectKey)}`,
				),
			);
			expect(external.videoRequests.at(-1)?.input_urls).toEqual([
				`https://private.video.test/${encodeURIComponent(ready.videoTemplateExecution!.sceneAsset!.objectKey)}`,
			]);
			expect(external.textPrompts.slice(before.texts)).toEqual([
				f.template.scene.prompt,
				f.template.video.prompt,
			]);
			expect(external.imageTasks.size - before.images).toBe(3);
			expect(await flow.repeat()).toEqual({ completed: true, stage: "READY" });
			await finalizeVideoJob(f.jobId);
			await authorizeVideoPlayback(f.ownerId, f.jobId);
			await assertReady(f);
			expect(external.sceneCalls - before.scene).toBe(1);
			expect(external.paidMockCalls - before.video).toBe(1);
			expect(external.sceneStoreCalls - before.sceneStore).toBe(1);
		}));

	it("recovers the persisted same scene after its database write response is lost without regenerating or rewriting it", async () =>
		runWithDatabaseClient(client, async () => {
			const f = await fixture();
			const before = {
				scene: external.sceneCalls,
				video: external.paidMockCalls,
				sceneStore: external.sceneStoreCalls,
			};
			let injected = false;
			const store: typeof templateDatabase = {
				...templateDatabase,
				async recordVideoTemplateSceneAsset(input) {
					const result = await templateDatabase.recordVideoTemplateSceneAsset(input);
					if (!injected) {
						injected = true;
						throw new Error("INJECTED_SCENE_DB_COMMIT_RESPONSE_LOST");
					}
					return result;
				},
			};
			expect((await execute(f, "scene-write-commit-response-lost", { store })).result).toEqual({
				completed: true,
				stage: "READY",
			});
			expect(injected).toBe(true);
			await assertReady(f);
			expect(external.sceneCalls - before.scene).toBe(1);
			expect(external.paidMockCalls - before.video).toBe(1);
			expect(external.sceneStoreCalls - before.sceneStore).toBe(1);
		}));

	it("preserves credits and both capacity budgets when scene acceptance is unknown and no final-video attempt exists", async () =>
		runWithDatabaseClient(client, async () => {
			const f = await fixture();
			const before = { scene: external.sceneCalls, video: external.paidMockCalls };
			external.loseSceneResponse = true;
			const flow = await execute(f, "ambiguous-scene-submit");
			expect(flow.result).toEqual({ completed: false, stage: "NEEDS_REVIEW" });
			const deps = dependencies();
			expect((await prepareVideoTemplate(f.jobId, deps.preparation)).status).toBe("ERROR");
			expect(await failVideoExecution(f.jobId, "INJECTED_RECOVERY_FAILURE")).toBe(false);
			await expect(failVideoDelivery(f.jobId, "INJECTED_DELIVERY_FAILURE")).rejects.toThrow(
				"VIDEO_UNCERTAIN_RESERVATION_MUST_REMAIN",
			);
			const job = await client.generationJob.findUniqueOrThrow({
				where: { id: f.jobId },
				include: { reservation: true, attempts: true, videoTemplateExecution: true },
			});
			expect(job.attempts).toHaveLength(0);
			expect(job.videoTemplateExecution?.sceneSubmissionUncertain).toBe(true);
			expect(job.reservation?.status).toBe("ACTIVE");
			expect(job.inputSnapshot).toEqual(f.parentSnapshot);
			expect(
				await client.storageUsageReservation.count({
					where: {
						ownerId: f.ownerId,
						status: "ACTIVE",
						referenceKey: { in: [`video-output:${f.jobId}`, `video-template-scene:${f.jobId}`] },
					},
				}),
			).toBe(2);
			expect(
				await client.creditLedgerEntry.count({
					where: { reservationId: f.reservationId, type: { in: ["SETTLE", "RELEASE"] } },
				}),
			).toBe(0);
			expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).toBeNull();
			expect(external.sceneCalls - before.scene).toBe(1);
			expect(external.paidMockCalls - before.video).toBe(0);
		}));

	it("keeps the same sealed scene and original reservation after final-video acceptance becomes ambiguous", async () =>
		runWithDatabaseClient(client, async () => {
			const f = await fixture();
			const deps = dependencies();
			const before = { scene: external.sceneCalls, video: external.paidMockCalls };
			expect(await prepareVideoTemplate(f.jobId, deps.preparation)).toEqual({ status: "ALLOW" });
			const sealed = await templateDatabase.getVideoTemplateExecution(f.jobId);
			expect(sealed?.resolvedInputIdentity).not.toBeNull();
			external.loseSubmitResponse = true;
			expect((await submitVideoAttempt(f.jobId, deps.video)).status).toBe("UNCERTAIN");
			expect((await submitVideoAttempt(f.jobId, deps.video)).status).toBe("UNCERTAIN");
			expect((await confirmVideoProviderResult(f.jobId, deps.video)).status).toBe("PENDING");
			expect(await failVideoExecution(f.jobId, "INJECTED_VIDEO_RECOVERY_FAILURE")).toBe(false);
			await expect(failVideoDelivery(f.jobId, "INJECTED_VIDEO_DELIVERY_FAILURE")).rejects.toThrow(
				"VIDEO_UNCERTAIN_RESERVATION_MUST_REMAIN",
			);
			const job = await client.generationJob.findUniqueOrThrow({
				where: { id: f.jobId },
				include: { reservation: true, attempts: true, videoTemplateExecution: true },
			});
			expect(job.reservation?.status).toBe("ACTIVE");
			expect(job.attempts).toHaveLength(1);
			expect(job.attempts[0]?.uncertainSubmission).toBe(true);
			expect(job.attempts[0]?.providerTaskId).toBeNull();
			expect(job.videoTemplateExecution?.resolvedInputIdentity).toEqual(
				sealed?.resolvedInputIdentity,
			);
			expect(job.inputSnapshot).toEqual(f.parentSnapshot);
			expect(
				await client.creditLedgerEntry.count({
					where: { reservationId: f.reservationId, type: { in: ["RELEASE", "SETTLE"] } },
				}),
			).toBe(0);
			expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).toBeNull();
			expect(external.sceneCalls - before.scene).toBe(1);
			expect(external.paidMockCalls - before.video).toBe(1);
		}));

	it("releases the single reservation once after an authoritative scene rejection and never submits final video", async () =>
		runWithDatabaseClient(client, async () => {
			const f = await fixture();
			const before = { scene: external.sceneCalls, video: external.paidMockCalls };
			external.sceneRejected = true;
			const flow = await execute(f, "definitive-scene-rejection");
			expect(flow.result).toEqual({ completed: true, stage: "REJECTED" });
			await failVideoDelivery(f.jobId, "REPEATED_FAILURE", true);
			expect(await failVideoExecution(f.jobId, "REPEATED_FAILURE", true)).toBe(false);
			const job = await client.generationJob.findUniqueOrThrow({
				where: { id: f.jobId },
				include: { reservation: true, attempts: true },
			});
			expect(job.reservation?.status).toBe("RELEASED");
			expect(job.attempts).toHaveLength(0);
			expect(
				await client.creditLedgerEntry.count({
					where: { reservationId: f.reservationId, type: "RELEASE" },
				}),
			).toBe(1);
			expect(
				await client.creditLedgerEntry.count({
					where: { reservationId: f.reservationId, type: "SETTLE" },
				}),
			).toBe(0);
			expect(await authorizeVideoPlayback(f.ownerId, f.jobId)).toBeNull();
			expect(external.sceneCalls - before.scene).toBe(1);
			expect(external.paidMockCalls - before.video).toBe(0);
		}));
});
