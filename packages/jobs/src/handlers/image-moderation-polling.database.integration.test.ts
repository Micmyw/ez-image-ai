import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	SeeapiSafetyAdapter,
	TestMediaSafetyAdapter,
	createRouteGraphSnapshot,
	type MediaProviderAdapter,
} from "@repo/ai";
import { SEEAPI_INPUT_DELEGATION_REASON } from "@repo/config";
import {
	wakeImageModeration,
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
	hasCurrentApprovedMediaAssetEvidence,
	hasCurrentImageInputEvidence,
	getOwnedMediaAssetReadState,
} from "@repo/database";
import { getTemporaryReferenceStatus } from "@repo/database";
import { runWithDatabaseClient } from "@repo/database/client";
import { PrismaClient, type Prisma } from "@repo/database/generated-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
	runPolling,
	type DurableSteps,
	type InvokeTask,
} from "../../../../apps/workflows/src/orchestrator";
import { createPreReviewedAdmissionFixture } from "../../../database/test-support/pre-reviewed-admission-fixture";
import { parsePollingTickResult, type PollingTickResult } from "../orchestration/contracts";
import { executeTask } from "../orchestration/executor";
import {
	createDatabaseVerifyUploadDependencies,
	createDatabaseDispatchStore,
	databaseVerifyUploadDependencies,
} from "../runtime";
import { dispatchGeneration } from "./dispatch-generation";

const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const context = { attempt: 1, maxAttempts: 1, runId: "moderation-polling-database-test" };

describe("image moderation callbacks through real PostgreSQL and Workflow polling", () => {
	let client: PrismaClient;
	const assetIds: string[] = [];

	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(url.protocol) ||
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			(url.pathname !== "/ai_media_foundation_test" &&
				url.pathname !== "/scanless_phase_owner_migration_test" &&
				!/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname)) ||
			url.search !== "" ||
			url.hash !== ""
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 6 }) });
	});

	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		if (!client) return;
		try {
			await client.outboxEvent.deleteMany({ where: { aggregateId: { in: assetIds } } });
			// Evidence is append-only. Its assets remain in the explicitly disposable
			// integration database; never disable the production immutability trigger.
		} finally {
			await client.$disconnect();
		}
	});

	async function fixture(
		kind: "INPUT" | "OUTPUT",
		finalStatus: "processing" | "succeeded" | "failed",
		options: {
			code?: string;
			delegate?: boolean;
			queryHttpError?: boolean;
			flagged?: boolean;
		} = {},
	) {
		const assetId = crypto.randomUUID();
		assetIds.push(assetId);
		const taskId = `review_${assetId}`;
		await client.user.create({
			data: {
				id: `moderation-poll-${assetId}`,
				name: "Test owner",
				email: `${assetId}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `moderation-poll-${assetId}`,
				kind,
				status: "VERIFYING",
				objectKey: `users/test/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "c".repeat(64),
				finalizedAt: new Date(),
			},
		});
		const read = () => client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
		const snapshots: Array<Awaited<ReturnType<typeof read>>> = [];
		const callbackResults: string[] = [];
		let retrievalCount = 0;
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const isSubmission = init?.method === "POST";
			if (!isSubmission) {
				retrievalCount++;
				const before = await read();
				snapshots.push(before);
				if (retrievalCount === 1) {
					callbackResults.push(
						await wakeImageModeration(
							{
								assetId,
								generation: before.verificationGeneration,
								submissionToken: before.verificationSubmissionToken!,
							},
							client,
						),
					);
					snapshots.push(await read());
				}
			}
			const status = !isSubmission && retrievalCount > 1 ? finalStatus : "processing";
			if (!isSubmission && retrievalCount > 1 && options.queryHttpError)
				return Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 });
			return Response.json({
				id: taskId,
				object: "inference",
				model: "nsfw-filter-2",
				endpoint: "image-moderation",
				provider: "seeapi",
				status,
				error:
					status === "failed"
						? {
								code: options.code ?? "DETECTION_REPORT_FAILED",
								message: "private provider diagnostic",
							}
						: null,
				result:
					status === "succeeded"
						? {
								type: "json",
								data: {
									flagged: options.flagged ?? false,
									categories: {
										nsfw: options.flagged ? ["sexual_suggestive"] : [],
										special_care: [],
									},
								},
							}
						: null,
			});
		});
		const adapter = new SeeapiSafetyAdapter({ apiKey: "local-fixture", fetch: fetcher });
		const submitImage = vi.fn(adapter.submitImage.bind(adapter));
		const retrieveImage = vi.fn(adapter.retrieveImage.bind(adapter));
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			environment: {
				MEDIA_SEEAPI_INPUT_FAILURE_DELEGATION_ENABLED: options.delegate ? "true" : "false",
			},
			moderationProvider: "seeapi",
			safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), { submitImage, retrieveImage }),
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: "fixture-etag",
				metadata: {},
			}),
			readMediaHeader: async () => PNG_HEADER,
			createSignedReadUrl: async () => "https://private.example/verified.png",
		});
		// Only external adapter wiring changes. Claim, commit, executor reads and
		// Workflow decisions all use their production implementations and real PG.
		vi.spyOn(databaseVerifyUploadDependencies, "verify").mockImplementation(dependencies.verify);
		const execute = async (queryOnly = false) =>
			runWithDatabaseClient(client, async () =>
				parsePollingTickResult(
					await executeTask(
						{
							taskId: "media-verify-upload",
							payload: { assetId, ...(queryOnly ? { queryOnly } : {}) },
						},
						context,
					),
				),
			);
		return {
			assetId,
			taskId,
			read,
			snapshots,
			callbackResults,
			submitImage,
			retrieveImage,
			execute,
		};
	}

	it.each(["RATE_LIMITED", "DETECTION_REPORT_FAILED", "PROVIDER_TIMEOUT"])(
		"delegates a proven %s input failure once and permits one model submission with the existing reservation",
		async (code) => {
			const f = await fixture("INPUT", "failed", { code, delegate: true });
			await f.execute();
			await f.execute(true);
			await f.execute(true);
			const asset = await f.read();
			expect(asset).toMatchObject({
				status: "READY",
				verificationProviderTaskId: f.taskId,
				verificationNextAttemptAt: null,
				verificationSubmissionUncertain: false,
			});
			expect(f.submitImage).toHaveBeenCalledTimes(1);
			expect(f.retrieveImage).toHaveBeenCalledTimes(2);
			const evidence = await client.assetModerationResult.findMany({
				where: { assetId: f.assetId },
				orderBy: { attemptNumber: "desc" },
			});
			expect(evidence.map((entry) => entry.status)).toEqual(["BYPASSED", "PENDING"]);
			expect(evidence[0]).toMatchObject({
				reasonCode: SEEAPI_INPUT_DELEGATION_REASON,
				rawEnvelope: {
					decision: "ERROR",
					evidence: { seeapiFailure: { taskId: f.taskId, code, status: "failed" } },
				},
			});
			const boundary = {
				provider: "seeapi",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				now: new Date(),
			};
			expect(
				hasCurrentImageInputEvidence({ ...asset, moderationResults: evidence }, boundary),
			).toBe(true);
			expect(
				hasCurrentApprovedMediaAssetEvidence({ ...asset, moderationResults: evidence }, boundary),
			).toBe(false);
			expect(
				await getOwnedMediaAssetReadState(
					{ assetId: asset.id, ownerId: asset.ownerId, verification: boundary },
					client,
				),
			).toMatchObject({ readable: true });
			const review = await client.moderationReview.findUniqueOrThrow({
				where: { targetType_targetId: { targetType: "ASSET", targetId: asset.id } },
			});
			expect(review).toMatchObject({ status: "PENDING_REVIEW", bypassed: true, failureCount: 1 });
			expect(
				await client.moderationIncident.findUniqueOrThrow({ where: { id: review.incidentId! } }),
			).toMatchObject({ status: "OPEN" });
			if (code === "RATE_LIMITED") {
				// The SQL guard must reject widening this input permission even if a writer errs.
				await expect(
					client.mediaAsset.update({ where: { id: asset.id }, data: { kind: "OUTPUT" } }),
				).rejects.toThrow();
				await expect(
					client.mediaAsset.update({
						where: { id: asset.id },
						data: { verificationEngine: "video-workflow-v1" },
					}),
				).rejects.toThrow();
				await expect(
					client.mediaAsset.update({
						where: { id: asset.id },
						data: { retentionClass: "GUEST_TRIAL" },
					}),
				).rejects.toThrow();
			}

			const account = await client.creditAccount.create({
				data: { ownerType: "USER", ownerId: asset.ownerId },
			});
			await createCreditGrant(
				{ accountId: account.id, amount: 20n, referenceKey: `delegation-grant:${asset.id}` },
				client,
			);
			const route = {
				provider: "kie" as const,
				providerModelId: "nano-banana-2-lite",
				providerCostMicros: 20_000,
				weight: 100,
			};
			const quoteInput = {
				ownerType: "USER" as const,
				ownerId: asset.ownerId,
				submittedByUserId: asset.ownerId,
				productKey: "image-nano-banana-2-lite",
				catalogVersion: "2026-09-07.2",
				pricingVersion: "2026-09-07.2",
				credits: 4n,
				costMicros: 20_000n,
				inputSnapshot: {
					kind: "image-to-image",
					prompt: "A calm landscape",
					sourceAssetId: asset.id,
					skuKey: "nano-banana-2-lite-1k",
					aspectRatio: "1:1",
				},
				pricingSnapshot: {
					routeGraph: createRouteGraphSnapshot({
						productKey: "image-nano-banana-2-lite",
						catalogVersion: "2026-09-07.2",
						pricingVersion: "2026-09-07.2",
						routes: [route],
					}),
				} as unknown as Prisma.InputJsonValue,
				expiresAt: new Date(Date.now() + 600_000),
			};
			const quote = await createModeratedGenerationQuoteTransaction(
				{
					...quoteInput,
					moderation: {
						decision: "ALLOW",
						provider: "test",
						ruleVersion: "v1",
						reasonCode: "NO_POLICY_MATCH",
						inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
					},
				},
				client,
			);
			const admission = {
				ownerType: "USER" as const,
				ownerId: asset.ownerId,
				submittedByUserId: asset.ownerId,
				quoteId: quote.id,
				idempotencyKey: `delegation-job:${asset.id}`,
				inputAssetIds: [asset.id],
				expectedModerationRuleVersion: "v1",
				expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			};
			const created = await createGenerationJobTransaction(admission, client);
			expect((await createGenerationJobTransaction(admission, client)).job.id).toBe(created.job.id);
			const store = createDatabaseDispatchStore(client, {
				enabledProviders: new Set(["kie"]),
				environment: {
					NODE_ENV: "test",
					MEDIA_SAFETY_ADAPTER: "configured",
					MODERATION_TEXT_WAFFO_ENABLED: "true",
					MODERATION_IMAGE_SEEAPI_ENABLED: "true",
					MEDIA_GENERATION_ENABLED: "true",
					MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
				},
				createSignedReadUrl: async () => "https://private.example/provider-input.png",
			});
			const submit = vi.fn(async () => ({
				outcome: "accepted" as const,
				providerTaskId: `model-${asset.id}`,
				status: "RUNNING" as const,
				idempotency: { providerSupported: false, replayed: false },
				reconciliation: {},
			}));
			const dependencies = {
				store,
				getProvider: () => ({ submit }) as unknown as MediaProviderAdapter,
				isGenerationEnabled: () => true,
			};
			const payload = { jobId: created.job.id, version: created.job.version };
			expect(await dispatchGeneration(payload, dependencies)).toMatchObject({
				outcome: "SUBMITTED",
			});
			await dispatchGeneration(payload, dependencies);
			expect(submit).toHaveBeenCalledTimes(1);
			expect(await client.generationAttempt.count({ where: { jobId: created.job.id } })).toBe(1);
			expect(
				await client.creditReservation.findUniqueOrThrow({ where: { jobId: created.job.id } }),
			).toMatchObject({ amount: 4n, status: "ACTIVE" });
		},
	);

	it.each([
		{ kind: "OUTPUT" as const, code: "RATE_LIMITED", delegate: true },
		{ kind: "INPUT" as const, code: "MEDIA_INVALID", delegate: true },
		{ kind: "INPUT" as const, code: "UNKNOWN_CODE", delegate: true },
		{ kind: "INPUT" as const, code: "RATE_LIMITED", delegate: false },
	])(
		"stops terminal polling without permission for $kind/$code (enabled=$delegate)",
		async ({ kind, code, delegate }) => {
			const f = await fixture(kind, "failed", { code, delegate });
			await f.execute();
			await f.execute(true);
			await f.execute(true);
			expect(await f.read()).toMatchObject({
				status: "VERIFICATION_FAILED",
				verificationNextAttemptAt: null,
			});
			expect(f.submitImage).toHaveBeenCalledOnce();
			expect(f.retrieveImage).toHaveBeenCalledTimes(2);
			expect(
				await client.assetModerationResult.count({
					where: { assetId: f.assetId, status: "BYPASSED" },
				}),
			).toBe(0);
		},
	);

	it.each(["guest", "anonymous account", "recheck", "prior rejection"] as const)(
		"does not delegate a %s input",
		async (scenario) => {
			const f = await fixture("INPUT", "failed", { delegate: true });
			if (scenario === "anonymous account")
				await client.user.update({
					where: { id: (await f.read()).ownerId },
					data: { isAnonymous: true },
				});
			if (scenario === "guest")
				await client.mediaAsset.update({
					where: { id: f.assetId },
					data: { retentionClass: "GUEST_TRIAL" },
				});
			if (scenario === "recheck")
				await client.mediaAsset.update({
					where: { id: f.assetId },
					data: { verificationGeneration: 2 },
				});
			if (scenario === "prior rejection")
				await client.assetModerationResult.create({
					data: {
						assetId: f.assetId,
						status: "REJECTED",
						provider: "seeapi",
						verificationGeneration: 1,
						attemptNumber: 0,
						evidenceKind: "INPUT",
						policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
						ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
						reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
						categories: {},
						rawEnvelope: {},
					},
				});
			await f.execute();
			await f.execute(true);
			expect(await f.read()).toMatchObject({
				status: "VERIFICATION_FAILED",
				verificationNextAttemptAt: null,
			});
			expect(
				await client.assetModerationResult.count({
					where: { assetId: f.assetId, status: "BYPASSED" },
				}),
			).toBe(0);
		},
	);

	it("keeps an HTTP 429 lookup failure pending instead of inventing a terminal task error", async () => {
		const f = await fixture("INPUT", "failed", { delegate: true, queryHttpError: true });
		await f.execute();
		await f.execute(true);
		expect(await f.read()).toMatchObject({
			status: "VERIFYING",
			verificationProviderTaskId: f.taskId,
			verificationLastErrorCode: "MODERATION_RATE_LIMITED",
		});
		expect(f.submitImage).toHaveBeenCalledOnce();
		expect(
			await client.assetModerationResult.count({
				where: { assetId: f.assetId, status: "BYPASSED" },
			}),
		).toBe(0);
	});

	it("keeps a real content rejection blocked with delegation enabled", async () => {
		const f = await fixture("INPUT", "succeeded", { delegate: true, flagged: true });
		await f.execute();
		await f.execute(true);
		expect(await f.read()).toMatchObject({
			status: "QUARANTINED",
			verificationLastErrorCode: "SEEAPI_CONTENT_NOT_ALLOWED",
		});
		expect(
			await client.assetModerationResult.count({
				where: { assetId: f.assetId, status: "BYPASSED" },
			}),
		).toBe(0);
	});

	it("atomically wakes an already reserved temporary-input job and reports availability without another review submission", async () => {
		const f = await createPreReviewedAdmissionFixture(client, {
			prefix: "seeapi-waiting",
			reviewStatus: "NOT_STARTED",
		});
		await client.user.create({
			data: {
				id: f.ownerId,
				name: "Test owner",
				email: `${f.ownerId}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		assetIds.push(f.asset.id);
		await client.mediaAsset.update({
			where: { id: f.asset.id },
			data: {
				verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			},
		});
		const admission = {
			...f.input(),
			validateCurrentEligibility: false,
			expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		};
		const created = await createGenerationJobTransaction(admission, client);
		const taskId = `task_${f.asset.id}`;
		const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
			Response.json({
				id: taskId,
				object: "inference",
				model: "nsfw-filter-2",
				endpoint: "image-moderation",
				provider: "seeapi",
				status: init?.method === "POST" ? "processing" : "failed",
				result: null,
				error:
					init?.method === "POST"
						? null
						: { code: "DETECTION_REPORT_FAILED", message: "Technical failure" },
			}),
		);
		const adapter = new SeeapiSafetyAdapter({ apiKey: "fixture-only", fetch: fetcher });
		const worker = createDatabaseVerifyUploadDependencies(client, {
			environment: { MEDIA_SEEAPI_INPUT_FAILURE_DELEGATION_ENABLED: "true" },
			moderationProvider: "seeapi",
			safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), {
				submitImage: adapter.submitImage.bind(adapter),
				retrieveImage: adapter.retrieveImage.bind(adapter),
			}),
			createSignedReadUrl: async () => "https://private.example/reference.png",
		});
		const result = await worker.verify(f.asset.id);
		await worker.verify(f.asset.id);
		expect(fetcher).toHaveBeenCalledTimes(2);
		const events = await client.outboxEvent.findMany({
			where: {
				aggregateId: created.job.id,
				dedupeKey: { startsWith: "generation-dispatch-after-verification:" },
			},
		});
		expect(events).toHaveLength(1);
		expect(result.verificationCommit?.eventIds).toContain(events[0]!.id);
		expect(
			await client.generationJob.findUniqueOrThrow({ where: { id: created.job.id } }),
		).toMatchObject({ status: "RESERVED", failureCode: null });
		expect(
			await client.creditReservation.findUniqueOrThrow({ where: { jobId: created.job.id } }),
		).toMatchObject({ status: "ACTIVE", amount: 5n });
		expect(
			await getTemporaryReferenceStatus(
				{
					ownerId: f.ownerId,
					reference: f.reference,
					verification: {
						provider: "seeapi",
						ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
						policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					},
				},
				client,
			),
		).toMatchObject({ status: "AVAILABLE", moderationStatus: "BYPASSED" });
		expect((await createGenerationJobTransaction(admission, client)).job.id).toBe(created.job.id);
	});

	it.each(["INPUT", "OUTPUT"] as const)(
		"immediately queries a %s callback received during its first query without a Workflow sleep or second submission",
		async (kind) => {
			const f = await fixture(kind, "succeeded");
			const polls: PollingTickResult[] = [];
			const sleep = vi.fn(async () => {
				throw new Error("UNEXPECTED_WORKFLOW_SLEEP");
			});
			const step: DurableSteps = { do: async (_name, _config, callback) => callback(), sleep };
			const invoke = vi.fn<InvokeTask>(async (request, executionContext) => {
				const poll = parsePollingTickResult(await executeTask(request, executionContext));
				polls.push(poll);
				return { status: "ok", poll };
			});
			const result = await runWithDatabaseClient(client, () =>
				runPolling(
					{ taskId: "media-verify-upload", payload: { assetId: f.assetId } },
					context.runId,
					step,
					invoke,
				),
			);
			expect(result).toMatchObject({ status: "ok", poll: { done: true, waitSeconds: 0 } });
			expect(polls).toMatchObject([
				{ done: false, queryOnly: true, retryImmediately: true, waitSeconds: 0 },
				{ done: true, waitSeconds: 0 },
			]);
			expect(sleep).not.toHaveBeenCalled();
			expect(invoke).toHaveBeenCalledTimes(2);
			expect(invoke.mock.calls[1]?.[0].payload).toEqual({ assetId: f.assetId, queryOnly: true });
			expect(f.submitImage).toHaveBeenCalledOnce();
			expect(f.retrieveImage).toHaveBeenCalledTimes(2);
			for (const [input] of f.retrieveImage.mock.calls)
				expect(input.moderationTaskId).toBe(f.taskId);
			expect(f.callbackResults).toEqual(["recorded"]);
			const [beforeCallback, afterCallback, secondQuery] = f.snapshots;
			expect(beforeCallback!.verificationCallbackReceivedAt).toBeNull();
			expect(afterCallback!.verificationCallbackReceivedAt).toBeInstanceOf(Date);
			expect(afterCallback!.verificationLeaseToken).toBe(beforeCallback!.verificationLeaseToken);
			expect(afterCallback!.verificationLeasedUntil).toEqual(
				beforeCallback!.verificationLeasedUntil,
			);
			expect(secondQuery!.verificationLeaseToken).not.toBe(beforeCallback!.verificationLeaseToken);
			expect(secondQuery!.verificationCallbackReceivedAt).toEqual(
				afterCallback!.verificationCallbackReceivedAt,
			);
			expect(await f.read()).toMatchObject({
				status: "READY",
				verificationGeneration: 1,
				verificationAttemptCount: 2,
				verificationProviderTaskId: f.taskId,
				verificationSubmissionUncertain: false,
				verificationLeaseToken: null,
				verificationNextAttemptAt: null,
			});
			expect(
				await client.assetModerationResult.findMany({
					where: { assetId: f.assetId },
					orderBy: { attemptNumber: "asc" },
				}),
			).toMatchObject([
				{
					status: "PENDING",
					providerTaskId: f.taskId,
					verificationGeneration: 1,
					attemptNumber: 1,
				},
				{
					status: "APPROVED",
					providerTaskId: f.taskId,
					verificationGeneration: 1,
					attemptNumber: 2,
				},
			]);
		},
	);

	it.each(["INPUT", "OUTPUT"] as const)(
		"restores persisted backoff after a %s callback has already been consumed",
		async (kind) => {
			const f = await fixture(kind, "processing");
			expect(await f.execute()).toMatchObject({
				retryImmediately: true,
				waitSeconds: 0,
				queryOnly: true,
			});
			const second = await f.execute(true);
			expect(second.retryImmediately).toBeUndefined();
			expect(second.waitSeconds).toBeGreaterThanOrEqual(1);
			const asset = await f.read();
			expect(asset.verificationNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
			expect(
				await wakeImageModeration(
					{
						assetId: f.assetId,
						generation: 1,
						submissionToken: asset.verificationSubmissionToken!,
					},
					client,
				),
			).toBe("recorded");
			expect((await f.execute(true)).retryImmediately).toBeUndefined();
			expect((await f.read()).verificationNextAttemptAt).toEqual(asset.verificationNextAttemptAt);
			expect(f.retrieveImage).toHaveBeenCalledTimes(2);
			expect(f.submitImage).toHaveBeenCalledOnce();
		},
	);

	it.each(["active lease", "uncertain submission"] as const)(
		"does not immediately poll or submit when a callback sees an %s",
		async (state) => {
			const f = await fixture("OUTPUT", "succeeded");
			const submissionToken = crypto.randomUUID();
			const leaseToken = state === "active lease" ? crypto.randomUUID() : null;
			await client.mediaAsset.update({
				where: { id: f.assetId },
				data: {
					verificationGeneration: 1,
					verificationProvider: "seeapi",
					verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					verificationProviderTaskId: state === "active lease" ? f.taskId : null,
					verificationSubmissionToken: submissionToken,
					verificationSubmissionUncertain: state === "uncertain submission",
					verificationLeaseToken: leaseToken,
					verificationLeasedUntil: leaseToken ? new Date(Date.now() + 120_000) : null,
					verificationNextAttemptAt: new Date(0),
				},
			});
			expect(
				await wakeImageModeration({ assetId: f.assetId, generation: 1, submissionToken }, client),
			).toBe("recorded");
			const result = await f.execute(true);
			expect(result).toMatchObject({ done: false });
			expect(result.retryImmediately).toBeUndefined();
			expect(result.waitSeconds).toBeGreaterThanOrEqual(1);
			expect(f.retrieveImage).not.toHaveBeenCalled();
			expect(f.submitImage).not.toHaveBeenCalled();
			expect(await f.read()).toMatchObject({
				status: "VERIFYING",
				verificationLeaseToken: leaseToken,
				verificationSubmissionUncertain: state === "uncertain submission",
				verificationSubmissionToken: submissionToken,
			});
		},
	);
});
