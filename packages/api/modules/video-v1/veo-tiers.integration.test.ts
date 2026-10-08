import { call } from "@orpc/server";
import { PrismaPg } from "@prisma/adapter-pg";
import { KieVideoModelsAdapter } from "@repo/ai/media/providers/kie-video-models";
import {
	VIDEO_MODEL_CATALOG_VERSION,
	videoModelInputSchema,
	videoModelReceiptInputSchema,
} from "@repo/config/video-models";
import { VIDEO_SUPPLIER_PRICE_VERSION } from "@repo/config/video-pricing.server";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";
import {
	createCreditGrant,
	releaseCredits,
	reserveCreditsInTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient } from "@repo/database/generated-client";
import { fingerprintVideoRequest } from "@repo/database/video-v1";
import { recordVideoInputReview } from "@repo/database/video-v1-execution";
import { submitVideoAttempt } from "@repo/jobs/video-v1/submission";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { isExplicitVideoVerificationTarget } from "../../../../tests/load/video-verification-target";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowBinding: () => undefined,
	getVideoWorkflowReadinessBindings: () => ({
		workflow: true,
		r2: true,
		hyperdrive: true,
		uploadCors: true,
	}),
}));
vi.mock("../media/lib/plan-entitlement", () => ({
	loadUserPlanEntitlement: async () => ({ maximumInputBytes: 10_000_000 }),
}));
import { auth } from "@repo/auth";

import { videoV1Router } from "./router";

// Real isolated PG and protected RPC; provider fetch and safety evidence are synthetic.
const environment = {
	VIDEO_V1_ENABLED: "true",
	VIDEO_V1_ACCESS: "authenticated",
	MEDIA_GENERATION_ENABLED: "true",
	KIE_API_KEY: "fixture-only",
	KIE_WEBHOOK_SECRET: "fixture-only",
	NEXT_PUBLIC_SAAS_URL: "https://video.example.test",
	VIDEO_V1_CALLBACK_BASE_URL: "https://video.example.test",
	VIDEO_V1_MODERATION_CALLBACK_CONFIGURED: "true",
	VIDEO_V1_MODERATION_WEBHOOK_SECRET: "casec_fixture-only",
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
	VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
	SEEAPI_API_KEY: "fixture-only",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local_test_signing_secret_20261004",
	}),
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-video-seeapi-callback-secret-20261004",
	WAFFO_MERCHANT_ID: "fixture-only",
	WAFFO_PRIVATE_KEY: "fixture-only",
	VIDEO_V1_PROVIDER_CONCURRENCY: "5",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_PRICE_BASIS: "RECORDED_BUDGET_TEST_ONLY_2026_10_08",
	VIDEO_PRICE_VALID_UNTIL: "none",
	VIDEO_COST_MODERATION_BASE_MICROS: "5100",
	VIDEO_COST_MODERATION_PER_SECOND_MICROS: "200",
	VIDEO_COST_RUNTIME_MICROS: "100000",
	VIDEO_COST_STORAGE_MICROS: "10000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
	VIDEO_COST_PAYMENT_FEE_BPS: "654",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
};
const tariffs = [
	["lite", "720p", 75_000n, [24, 24, 24]],
	["lite", "1080p", 112_500n, [29, 29, 29]],
	["lite", "4k", 375_000n, [61, 61, 61]],
	["fast", "720p", 150_000n, [33, 33, 33]],
	["fast", "1080p", 187_500n, [38, 38, 38]],
	["fast", "4k", 450_000n, [70, 70, 70]],
	["quality", "720p", 1_125_000n, [153, 154, 154]],
	["quality", "1080p", 1_162_500n, [158, 158, 158]],
	["quality", "4k", 1_425_000n, [190, 190, 191]],
] as const;
const base = {
	productKey: "video-veo-3-1",
	mode: "text-to-video" as const,
	prompt: "A sailboat crosses a calm blue lake",
	duration: 8,
	resolution: "1080p",
	aspectRatio: "16:9",
	sound: true,
	veoTier: "lite" as const,
};
const ctx = { context: { headers: new Headers() } };
let client: PrismaClient;
let ownerId: string;
let accountId: string;
beforeAll(async () => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (!connectionString) throw new Error("BLOCKED: explicit TEST_DATABASE_URL required");
	if (!isExplicitVideoVerificationTarget(new URL(connectionString)))
		throw new Error("ISOLATED_VIDEO_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
});
beforeEach(async () => {
	for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
	ownerId = `veo-tier-test-${crypto.randomUUID()}`;
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { id: ownerId, role: "user", isAnonymous: false },
		session: { id: "test-session" },
	} as never);
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	accountId = account.id;
	const id = crypto.randomUUID();
	const plan = await client.billingPlan.create({
		data: {
			provider: "paypal",
			providerPriceId: id,
			name: "ISOLATED_VEO_PAID_FIXTURE",
			creditsPerPeriod: 1000n,
			priceMicros: 30_000_000n,
			currency: "USD",
			metadata: {},
		},
	});
	const subscription = await client.subscription.create({
		data: {
			ownerType: "USER",
			ownerId,
			provider: "paypal",
			providerSubscriptionId: id,
			planId: plan.id,
			status: "ACTIVE",
		},
	});
	const referenceKey = `paypal-payment:${id}:period:0:grant`;
	await client.billingPeriod.create({
		data: {
			subscriptionId: subscription.id,
			startsAt: new Date(Date.now() - 1000),
			endsAt: new Date(Date.now() + 86400_000),
			status: "ACTIVE",
			creditAmount: 1000n,
			grantReferenceKey: referenceKey,
			providerInvoiceId: id,
			providerInvoicePaymentId: `paypal:${id}`,
			paidAmount: 30_000_000n,
			refundedAmount: 0n,
		},
	});
	await createCreditGrant({ accountId, amount: 1000n, referenceKey }, client);
});
afterEach(async () => {
	if (accountId)
		for (const reservation of await client.creditReservation.findMany({
			where: { accountId, status: "ACTIVE" },
		}))
			await releaseCredits(
				{
					reservationId: reservation.id,
					amount: reservation.amount,
					referenceKey: `cleanup:${reservation.id}`,
				},
				client,
			);
	await client.videoExecution.updateMany({
		where: { job: { ownerId } },
		data: { stage: "FAILED" },
	});
	await client.generationJob.updateMany({
		where: { ownerId },
		data: { status: "FAILED", terminalAt: new Date() },
	});
	vi.unstubAllEnvs();
});
afterAll(async () => {
	await client?.$disconnect();
});
async function sealedInput() {
	return client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			verificationEngine: "video-workflow-v1",
			objectKey: `test/${ownerId}.png`,
			mimeType: "image/png",
			byteSize: 100n,
			width: 1280,
			height: 720,
			checksum: "a".repeat(64),
			finalizedAt: new Date(),
		},
	});
}
describe("protected Veo quote, receipt and dispatch", () => {
	const cases = tariffs.flatMap(([veoTier, resolution, cost, credits]) =>
		[4, 6, 8].flatMap((duration, index) =>
			(["text-to-video", "image-to-video"] as const).map((mode) => ({
				veoTier,
				resolution,
				cost,
				credits: String(credits[index]),
				duration,
				mode,
			})),
		),
	);
	it.each(cases)(
		"quotes $veoTier $resolution $duration $mode with the independent tariff",
		async (test) => {
			const request = videoModelInputSchema.parse({
				...base,
				veoTier: test.veoTier,
				resolution: test.resolution,
				duration: test.duration,
				mode: test.mode,
				...(test.mode === "image-to-video" ? { inputAssetId: (await sealedInput()).id } : {}),
			});
			await runWithDatabaseClient(client, async () => {
				const quoted = await call(videoV1Router.quote, request, ctx);
				expect(quoted.credits).toBe(test.credits);
				const quote = await client.generationQuote.findUniqueOrThrow({
					where: { id: quoted.quoteId },
				});
				expect(quote.costMicros).toBe(test.cost + 5100n + BigInt(test.duration) * 200n);
				expect(quote.inputSnapshot).toMatchObject({
					...request,
					resolutionPolicy: {
						schemaVersion: 1,
						kind: "minimum-short-edge",
						minimumShortEdge: { "720p": 720, "1080p": 1080, "4k": 2160 }[test.resolution],
					},
				});
				expect(quote.inputFingerprint).toBe(fingerprintGenerationQuoteSecurityPayload(quote));
			});
		},
	);
	it("keeps the five-slot legacy capacity gate and admits the same receipt only after fixture slots settle", async () => {
		const blockers: string[] = [];
		for (let index = 0; index < 5; index++) {
			const quote = await client.generationQuote.create({
				data: {
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					productKey: "image-nano-banana-2-lite",
					catalogVersion: "ISOLATED_CAPACITY_FIXTURE",
					pricingVersion: "ISOLATED_CAPACITY_FIXTURE",
					credits: 1n,
					costMicros: 1n,
					inputSnapshot: {},
					pricingSnapshot: {},
					expiresAt: new Date(Date.now() + 60_000),
				},
			});
			const job = await client.generationJob.create({
				data: {
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey: crypto.randomUUID(),
					productKey: quote.productKey,
					catalogVersion: quote.catalogVersion,
					pricingVersion: quote.pricingVersion,
					creditsReserved: 1n,
					executionEngine: "legacy",
					status: "RESERVED",
					inputSnapshot: {},
					pricingSnapshot: {},
				},
			});
			blockers.push(job.id);
		}
		await runWithDatabaseClient(client, async () => {
			const quote = await call(videoV1Router.quote, base, ctx);
			const receipt = {
				quoteId: quote.quoteId,
				idempotencyKey: crypto.randomUUID(),
				request: base,
			};
			await expect(call(videoV1Router.jobs.create, receipt, ctx)).rejects.toMatchObject({
				message: "VIDEO_PROVIDER_BUSY",
			});
			expect(await client.creditReservation.count({ where: { accountId } })).toBe(0);
			expect(await client.generationJob.count({ where: { quoteId: quote.quoteId } })).toBe(0);
			// Only this case's synthetic slots settle; never rewrite other suites' jobs.
			await client.generationJob.updateMany({
				where: { id: { in: blockers }, ownerId },
				data: { status: "FAILED", terminalAt: new Date() },
			});
			const created = await call(videoV1Router.jobs.create, receipt, ctx);
			expect(await client.creditReservation.count({ where: { accountId } })).toBe(1);
			await expect(call(videoV1Router.jobs.create, receipt, ctx)).resolves.toMatchObject({
				jobId: created.jobId,
			});
			expect(await client.creditReservation.count({ where: { accountId } })).toBe(1);
		});
	});
	it.each(
		(["lite", "fast", "quality"] as const).flatMap((veoTier) =>
			(["text-to-video", "image-to-video"] as const).map((mode) => ({ veoTier, mode })),
		),
	)(
		"preserves $veoTier $mode from signed quote through a single fenced provider submission",
		async ({ veoTier, mode }) => {
			const request = videoModelInputSchema.parse({
				...base,
				veoTier,
				mode,
				...(mode === "image-to-video" ? { inputAssetId: (await sealedInput()).id } : {}),
			});
			await runWithDatabaseClient(client, async () => {
				const quoted = await call(videoV1Router.quote, request, ctx);
				const receipt = { quoteId: quoted.quoteId, idempotencyKey: crypto.randomUUID(), request };
				const wrongTier = veoTier === "quality" ? "lite" : "quality";
				await expect(
					call(
						videoV1Router.jobs.create,
						{ ...receipt, request: { ...request, veoTier: wrongTier } },
						ctx,
					),
				).rejects.toMatchObject({ message: "PRICE_CHANGED" });
				const created = await call(videoV1Router.jobs.create, receipt, ctx);
				const job = await client.generationJob.findUniqueOrThrow({ where: { id: created.jobId } });
				const quote = await client.generationQuote.findUniqueOrThrow({
					where: { id: receipt.quoteId },
				});
				expect(job.inputSnapshot).toEqual(quote.inputSnapshot);
				await expect(
					call(
						videoV1Router.jobs.create,
						{ ...receipt, request: { ...request, veoTier: wrongTier } },
						ctx,
					),
				).rejects.toMatchObject({ message: "IDEMPOTENCY_CONFLICT" });
				const textSafetyProfile = createVideoTextSafetyProfile();
				await recordVideoInputReview(job.id, {
					status: "ALLOW",
					ruleVersion: VIDEO_V1_RULE_VERSION,
					requestFingerprint: fingerprintVideoRequest(ownerId, request),
					textSafetyProfile,
					textDecision: {
						decision: "ALLOW",
						reasonCode: "WAFFO_PROMPT_ALLOWED",
						ruleVersion: textSafetyProfile.ruleVersion,
						evidence: {
							requestId: "fixture",
							models: ["waffo-prompt-sift"],
							operations: 1,
							waffo: {
								requestId: "fixture",
								action: "allow",
								semanticStatus: "scored",
								matchedCategories: [],
							},
						},
					},
					validUntil: new Date(Date.now() + 60_000).toISOString(),
				});
				const fetch = vi.fn<typeof globalThis.fetch>(async () =>
					Response.json({ code: 200, data: { taskId: `fake-${job.id}` } }),
				);
				const adapter = new KieVideoModelsAdapter({ apiKey: "fixture", fetch });
				const overrides = {
					env: environment,
					provider: {
						submit: adapter.submit.bind(adapter),
						retrieve: adapter.retrieve.bind(adapter),
					},
					signRead: async () => "https://private.example.test/sealed.png",
				};
				await expect(submitVideoAttempt(job.id, overrides)).resolves.toMatchObject({
					status: "ACCEPTED",
				});
				const body = fetch.mock.calls[0]![1]!.body;
				if (typeof body !== "string") throw new Error("Expected the provider's JSON request body");
				expect(JSON.parse(body)).toMatchObject({
					model: "veo-3-1",
					input: {
						model: { lite: "veo3_lite", fast: "veo3_fast", quality: "veo3" }[veoTier],
						resolution: request.resolution,
						duration: request.duration,
					},
				});
				vi.stubEnv("VIDEO_V1_ENABLED", "false");
				await expect(call(videoV1Router.jobs.create, receipt, ctx)).resolves.toMatchObject({
					jobId: job.id,
				});
				await expect(submitVideoAttempt(job.id, overrides)).resolves.toMatchObject({
					status: "ACCEPTED",
				});
				expect(fetch).toHaveBeenCalledTimes(1);
				expect(await client.creditReservation.count({ where: { accountId } })).toBe(1);
				expect(
					(await client.generationAttempt.findFirstOrThrow({ where: { jobId: job.id } }))
						.requestSnapshot,
				).toEqual(job.inputSnapshot);
			});
		},
	);
	it.each([
		["video-veo-3-1", "1d529afa7841ff9b8b60b6ca178ca8ab0d8d2ff541beec20e8d62b52d1aa1daa"],
		["video-veo-3-1-fast", "3a32daeebaf8bb01de84c1288533f68126bf9cd51661669b14fbc0e86afec3cc"],
	])(
		"keeps the fixed historical fingerprint and accepted %s receipt unchanged",
		async (productKey, hash) => {
			const request = videoModelReceiptInputSchema.parse({
				productKey,
				mode: "text-to-video",
				prompt: "A calm lake",
				duration: 4,
				resolution: "720p",
				aspectRatio: "16:9",
				sound: true,
			});
			expect(fingerprintVideoRequest("fixed-tier-owner", request)).toBe(hash);
			expect(request).not.toHaveProperty("veoTier");
			await runWithDatabaseClient(client, async () => {
				const current = await call(videoV1Router.quote, base, ctx);
				const {
					id: _id,
					createdAt: _createdAt,
					...fields
				} = await client.generationQuote.findUniqueOrThrow({ where: { id: current.quoteId } });
				const {
					veoTier: _tier,
					resolutionPolicy: _policy,
					...snapshot
				} = fields.inputSnapshot as Record<string, unknown>;
				const historical = {
					...fields,
					productKey,
					catalogVersion: "video-models-2026-10-04.2",
					pricingVersion: "kie-public-2026-10-07.1",
					expiresAt: new Date(Date.now() - 60_000),
					inputSnapshot: {
						...snapshot,
						...request,
						modelContractVersion: "video-models-2026-10-04.2",
						requestFingerprint: fingerprintVideoRequest(ownerId, request),
					},
				};
				const quote = await client.generationQuote.create({
					data: {
						...historical,
						inputSnapshot: historical.inputSnapshot as never,
						pricingSnapshot: fields.pricingSnapshot as never,
						inputFingerprint: fingerprintGenerationQuoteSecurityPayload(historical),
					},
				});
				const idempotencyKey = crypto.randomUUID();
				const job = await client.$transaction(async (tx) => {
					const accepted = await tx.generationJob.create({
						data: {
							ownerType: "USER",
							ownerId,
							submittedByUserId: ownerId,
							quoteId: quote.id,
							idempotencyKey,
							productKey,
							catalogVersion: quote.catalogVersion,
							pricingVersion: quote.pricingVersion,
							creditsReserved: quote.credits,
							executionEngine: "video-workflow-v1",
							inputSnapshot: quote.inputSnapshot as never,
							pricingSnapshot: quote.pricingSnapshot as never,
						},
					});
					await reserveCreditsInTransaction(
						{
							accountId,
							jobId: accepted.id,
							amount: quote.credits,
							referenceKey: `job:${accepted.id}:reserve`,
						},
						tx,
					);
					await tx.videoExecution.create({
						data: {
							jobId: accepted.id,
							workflowInstanceId: `video-v1-${accepted.id}`,
							modelContractVersion: quote.catalogVersion,
							stage: "QUEUED",
							startState: "PENDING",
						},
					});
					return accepted;
				});
				vi.stubEnv("VIDEO_V1_ENABLED", "false");
				const receipt = { quoteId: quote.id, idempotencyKey, request };
				await expect(call(videoV1Router.jobs.create, receipt, ctx)).resolves.toMatchObject({
					jobId: job.id,
				});
				expect(
					(await client.generationJob.findUniqueOrThrow({ where: { id: job.id } })).inputSnapshot,
				).toEqual(quote.inputSnapshot);
				expect(await client.creditReservation.count({ where: { accountId } })).toBe(1);
				vi.stubEnv("VIDEO_V1_ENABLED", "true");
				await expect(
					call(videoV1Router.jobs.create, { ...receipt, idempotencyKey: crypto.randomUUID() }, ctx),
				).rejects.toMatchObject({ code: "BAD_REQUEST" });
			});
		},
	);
});
