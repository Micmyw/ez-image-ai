import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoAudioSafetyPolicy } from "@repo/config/video-output";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import {
	sourceTemplateInternalRequestSchema,
	sourceTemplateConfigKey,
	isProviderOwnedSourceTemplate,
	createSourceTemplateNoPromptReview,
} from "@repo/config/video-template-execution.server";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	archivedSourceMaterials,
	prepareArchivedSourceTemplateConfig,
} from "../../../../ai/media/rap-templates/archive";
import { resolveSourceTemplateRequest } from "../../../../ai/media/rap-templates/contracts";
import { sourceHotelTemplateFixture } from "../../../../config/test-support/source-hotel-template";
import { runWithDatabaseClient } from "../../client";
import { PrismaClient } from "../../generated/client";
import { createCreditGrant, getCreditInvariantReport } from "./credits";
import { createRuntimeConfigOverride } from "./operations";
import { applySourceTemplateProvisionBundle } from "./video-source-template-admission";
import {
	persistSourceTemplateCallback,
	claimSourceTemplateCallback,
	finishSourceTemplateCallback,
} from "./video-source-template-events";
import {
	claimSourceTemplateImageReview,
	recordSourceTemplateImageReview,
	recordSourceTemplateInputReview,
} from "./video-source-template-review";
import {
	createVideoJobRecord,
	createVideoQuoteRecord,
	findExistingVideoAdmission,
} from "./video-v1";
import {
	claimVideoProviderSubmission,
	failVideoExecution,
	markVideoSubmissionUncertain,
	recordVideoSubmissionAccepted,
} from "./video-v1-execution";

describe("source templates atomic admission in isolated PostgreSQL", () => {
	let client: PrismaClient;
	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("EXPLICIT_TEST_DATABASE_REQUIRED");
		const url = new URL(connectionString);
		if (
			!["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
			!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1))
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 5 }) });
	});
	afterAll(async () => {
		await client?.$disconnect();
	});
	// These database-only approvals and object keys never attest actual visual review,
	// uploaded bytes, rights, generation, or production readiness. The archived SHA and
	// byte length identify the original scene; no substitute scene is generated.
	async function isolatedSceneReference() {
		const material = archivedSourceMaterials.find(
			(item) => item.sourceConfigKey === "spin-me-round" && item.role === "empty-room",
		)!;
		const ownerId = `source-reference-test-${crypto.randomUUID()}`;
		const now = new Date();
		const validUntil = new Date(now.getTime() + 3600_000);
		const taskId = `isolated-test-reference-review-${crypto.randomUUID()}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "ISOLATED TEST FIXTURE ADMINISTRATOR",
				email: `${ownerId}@example.invalid`,
				emailVerified: true,
				role: "admin",
				createdAt: now,
				updatedAt: now,
			},
		});
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `test-only/source-reference/${ownerId}/empty-room.png`,
				mimeType: "image/png",
				byteSize: BigInt(material.bytes),
				checksum: material.sha256,
				storageEtag: "isolated-test-scene-etag",
				finalizedAt: now,
				verificationProvider: "seeapi",
				verificationProviderTaskId: taskId,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationRuleVersion: "ISOLATED_TEST_ONLY",
				verificationPolicyVersion: "ISOLATED_TEST_ONLY",
				verificationValidUntil: validUntil,
			},
		});
		const reference = {
			assetId: asset.id,
			checksum: material.sha256,
			objectKey: asset.objectKey,
			storageEtag: asset.storageEtag!,
			storageVersionId: null,
			verificationGeneration: 1,
			sourceUrl: material.transportUrl,
			ownerId,
			rightsEvidence: "ISOLATED TEST FIXTURE; NO REAL RIGHTS OR REVIEW ATTESTATION",
			validUntil: validUntil.toISOString(),
		};
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: material.sha256,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "seeapi",
				providerTaskId: taskId,
				ruleVersion: "ISOLATED_TEST_ONLY",
				policyVersion: "ISOLATED_TEST_ONLY",
				status: "APPROVED",
				reasonCode: "ISOLATED_TEST_FIXTURE",
				categories: [],
				validUntil,
				rawEnvelope: {
					seeapi: { taskId, flagged: false, nsfw: [], specialCare: [] },
					sourceTemplateReferenceApproval: {
						...reference,
						templateKey: "spin-me-round",
						version: "test-only-source-contract",
						decision: "ALLOW",
						reviewerId: ownerId,
						reviewedAt: now.toISOString(),
						reviewKind: "visual",
					},
				},
			},
		});
		await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
		return reference;
	}
	async function fixture(
		count = 2,
		balance = 100n,
		templateKey: "original-rap" | "spin-me-round" | "source-hotel-lobby" = "original-rap",
	) {
		const ownerId = `source-template-test-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		await createCreditGrant(
			{ accountId: account.id, amount: balance, referenceKey: `test-only:${ownerId}` },
			client,
		);
		const assets = [];
		for (let i = 0; i < count; i++)
			assets.push(
				await client.mediaAsset.create({
					data: {
						ownerType: "USER",
						ownerId,
						kind: "INPUT",
						status: "VERIFYING",
						verificationEngine: "video-workflow-v1",
						objectKey: `test/source-template/${ownerId}/${i}.png`,
						mimeType: "image/png",
						byteSize: 100n,
						width: 100,
						height: 100,
						checksum: String(i + 1).repeat(64),
						storageEtag: `fixture-etag-${i}`,
						finalizedAt: new Date(),
					},
				}),
			);
		const options =
			templateKey === "source-hotel-lobby"
				? { resolution: "768P" as const, aspectRatio: "9:16" as const }
				: {
						tier: "standard" as const,
						preset: count
							? count === 1
								? ("solo" as const)
								: ("duo" as const)
							: ("text" as const),
						durationSeconds: 12 as const,
						resolution: "720p" as const,
						aspectRatio: "9:16" as const,
						stageId: "orange-studio" as const,
						sceneId: "empty-room" as const,
						locale: "en" as const,
					};
		const sourceConfig = prepareArchivedSourceTemplateConfig(templateKey);
		const references = templateKey === "spin-me-round" ? [await isolatedSceneReference()] : [];
		const originalTransport = resolveSourceTemplateRequest({
			templateKey,
			options,
			userImageUrls: assets.map((_, i) => `https://ezpic-template.example/user/performer-${i + 1}`),
			configs: sourceConfig,
		});
		const transport: typeof originalTransport = JSON.parse(
			JSON.stringify(originalTransport, (_key, value: unknown) => {
				const index = references.findIndex((reference) => reference.sourceUrl === value);
				return index >= 0 ? `https://ezpic-template.example/reference/${index}` : value;
			}),
		);
		const configuration = await createRuntimeConfigOverride(
			{
				configKey: sourceTemplateConfigKey(templateKey),
				value: {
					version: "test-only-source-contract",
					enabled: true,
					access: "authenticated",
					sourceConfig,
					references,
					prices: [],
				},
				reason: "ISOLATED TEST ONLY; NOT A REAL PRICE OR APPROVAL",
				createdByUserId: ownerId,
			},
			client,
		);
		const request = sourceTemplateInternalRequestSchema.parse({
			requestKind: "source-template-video",
			productKey: `source-template:${templateKey}`,
			mode: count ? "image-to-video" : "text-to-video",
			prompt: transport.prompt,
			...(assets[0] ? { inputAssetId: assets[0].id } : {}),
			duration: transport.output.durationSeconds,
			resolution: transport.output.resolution,
			aspectRatio: "9:16",
			sound: true,
			sourceTemplate: {
				templateKey,
				version: "test-only-source-contract",
				provision: { id: configuration.id, version: configuration.version },
				request: {
					templateKey,
					options,
					inputs: assets.map((asset, i) => ({ role: `performer-${i + 1}`, assetId: asset.id })),
				},
				transport,
				references,
			},
		});
		const input = {
			ownerId,
			request,
			price: {
				credits: 7n,
				pricingVersion: "TEST_ONLY",
				providerCostMicros: 2n,
				moderationCostMicros: 1n,
				pricingBasis: "ISOLATED_TEST_NOT_FORMAL_PRICE",
				pricingDetails: {
					paidRevenueQualified: false,
					funding: { mode: "shared-media-credits-v1" },
				},
			},
			visualSafetyProfile: createVideoVisualSafetyProfile(
				"seeapi",
				templateKey === "source-hotel-lobby" ? 30 : 12,
			),
			textSafetyProfile: createVideoTextSafetyProfile(),
			audioSafetyPolicy: createVideoAudioSafetyPolicy(),
			maximumInputBytes: 10000000,
		};
		const quote = await createVideoQuoteRecord(input, client);
		const createInput = {
			...input,
			quoteId: quote.quoteId,
			idempotencyKey: crypto.randomUUID(),
			limits: { maximumStorageBytes: 1000000000n, maximumInputBytes: 10000000 },
		};
		return { ownerId, account, assets, configuration, request, input, quote, createInput };
	}
	const scoped = <T>(callback: () => Promise<T>) => runWithDatabaseClient(client, callback);
	it("addresses callback receipts directly, deduplicates concurrent delivery, and grants one confirmation without Outbox", async () => {
		const f = await fixture(0);
		const { jobId } = await createVideoJobRecord(f.createInput, client);
		await approveFixtureInputReview(jobId);
		const claimed = await claimFixtureSubmission(jobId, f);
		if (!("attempt" in claimed)) throw new Error("EXPECTED_ATTEMPT");
		const attempt = await client.generationAttempt.findUniqueOrThrow({
			where: { id: claimed.attempt.id },
		});
		const scope = { phase: "generation" as const, jobId, attemptId: attempt.id };
		const rawBody =
			'{"id":"untrusted","status":"succeeded","url":"https://ignored.invalid/video.mp4"}';
		const input = {
			phase: "generation" as const,
			provider: "seeapi" as const,
			tokenHash: attempt.callbackTokenHash!,
			rawBody,
			eventHash: createHash("sha256").update(rawBody).digest("hex"),
			receivedAt: new Date(),
		};
		expect(await scoped(() => claimSourceTemplateCallback(scope))).toBeNull();
		const callbacks = await Promise.all(
			Array.from({ length: 3 }, () => scoped(() => persistSourceTemplateCallback(input))),
		);
		expect(new Set(callbacks.map((item) => item.eventId)).size).toBe(1);
		expect(
			await client.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
		).toMatchObject({ providerTaskId: null, uncertainSubmission: true });
		expect(await scoped(() => claimSourceTemplateCallback(scope))).toBeNull();
		await scoped(() =>
			recordVideoSubmissionAccepted(jobId, attempt.id, `accepted-source-${jobId}`),
		);
		const confirmations = await Promise.allSettled(
			Array.from({ length: 2 }, () => scoped(() => claimSourceTemplateCallback(scope))),
		);
		expect(
			confirmations.filter(
				(item) => item.status === "fulfilled" && item.value === callbacks[0]!.eventId,
			),
		).toHaveLength(1);
		expect(confirmations.filter((item) => item.status === "rejected")).toHaveLength(1);
		await scoped(() => finishSourceTemplateCallback(callbacks[0]!.eventId));
		expect(await scoped(() => persistSourceTemplateCallback(input))).toMatchObject({
			replayed: true,
			notified: true,
		});
		expect(await scoped(() => claimSourceTemplateCallback(scope))).toBeNull();
		await client.videoExecution.update({ where: { jobId }, data: { stage: "NEEDS_REVIEW" } });
		const lateBody = '{"late":true}';
		const late = await scoped(() =>
			persistSourceTemplateCallback({
				...input,
				rawBody: lateBody,
				eventHash: createHash("sha256").update(lateBody).digest("hex"),
			}),
		);
		expect(late.notified).toBe(true);
		expect(
			await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: late.eventId } }),
		).toMatchObject({ status: "IGNORED" });
		await expect(scoped(() => claimSourceTemplateCallback(scope))).rejects.toThrow(
			"SOURCE_CALLBACK_EXECUTION_HELD",
		);
		expect(
			await client.outboxEvent.count({ where: { payload: { path: ["jobId"], equals: jobId } } }),
		).toBe(0);
		expect(await client.creditReservation.findUniqueOrThrow({ where: { jobId } })).toMatchObject({
			status: "ACTIVE",
			amount: 7n,
			releasedAmount: 0n,
			settledAmount: 0n,
		});
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});
	it("keeps input callbacks role-bound, stores early evidence, and stops queries at the database deadline", async () => {
		const f = await fixture(2);
		const { jobId } = await createVideoJobRecord(f.createInput, client);
		const tokenHash = createHash("sha256").update(crypto.randomUUID()).digest("hex");
		await scoped(() => claimSourceTemplateImageReview(jobId, "performer-2", tokenHash));
		const rawBody = '{"done":true}';
		const input = {
			phase: "input" as const,
			provider: "seeapi" as const,
			jobId,
			role: "performer-2",
			tokenHash,
			rawBody,
			eventHash: createHash("sha256").update(rawBody).digest("hex"),
			receivedAt: new Date(),
		};
		await expect(
			scoped(() => persistSourceTemplateCallback({ ...input, role: "performer-1" })),
		).rejects.toThrow("SOURCE_CALLBACK_IDENTITY_INVALID");
		const event = await scoped(() => persistSourceTemplateCallback(input));
		const scope = { phase: "input" as const, jobId, role: "performer-2" };
		expect(await scoped(() => claimSourceTemplateCallback(scope))).toBeNull();
		await scoped(() =>
			recordSourceTemplateImageReview(jobId, "performer-2", {
				taskId: "input-task",
				submissionUncertain: false,
			}),
		);
		expect(await scoped(() => claimSourceTemplateCallback(scope))).toBe(event.eventId);
		await scoped(() => finishSourceTemplateCallback(event.eventId));
		await client.videoExecution.update({
			where: { jobId },
			data: { inputReviewDeadlineAt: new Date(Date.now() - 1000) },
		});
		await expect(scoped(() => claimSourceTemplateCallback(scope))).rejects.toThrow(
			"SOURCE_CALLBACK_DEADLINE",
		);
		expect(
			await client.outboxEvent.count({ where: { payload: { path: ["jobId"], equals: jobId } } }),
		).toBe(0);
	});
	it("retains failed callback reads and the same reservation without admitting another confirmation", async () => {
		const f = await fixture(0);
		const { jobId } = await createVideoJobRecord(f.createInput, client);
		await approveFixtureInputReview(jobId);
		const claim = await claimFixtureSubmission(jobId, f);
		if (!("attempt" in claim)) throw new Error("EXPECTED_ATTEMPT");
		const attempt = await client.generationAttempt.findUniqueOrThrow({
			where: { id: claim.attempt.id },
		});
		await scoped(() => recordVideoSubmissionAccepted(jobId, attempt.id, `accepted-${jobId}`));
		const rawBody = "{}";
		const event = await scoped(() =>
			persistSourceTemplateCallback({
				phase: "generation",
				provider: "seeapi",
				tokenHash: attempt.callbackTokenHash!,
				rawBody,
				eventHash: createHash("sha256").update(rawBody).digest("hex"),
				receivedAt: new Date(),
			}),
		);
		const scope = { phase: "generation" as const, jobId, attemptId: attempt.id };
		expect(await scoped(() => claimSourceTemplateCallback(scope))).toBe(event.eventId);
		await scoped(() => finishSourceTemplateCallback(event.eventId, true));
		await expect(scoped(() => claimSourceTemplateCallback(scope))).rejects.toThrow(
			"SOURCE_CALLBACK_CONFIRMATION_HELD",
		);
		expect(await client.generationAttempt.count({ where: { jobId } })).toBe(1);
		expect(await client.creditReservation.findUniqueOrThrow({ where: { jobId } })).toMatchObject({
			status: "ACTIVE",
			releasedAmount: 0n,
			settledAmount: 0n,
		});
	});
	async function approveFixturePortraits(jobId: string, roles: string[]) {
		for (const role of roles) {
			const taskId = `isolated-test-portrait-${crypto.randomUUID()}`;
			expect(await scoped(() => claimSourceTemplateImageReview(jobId, role))).toBe(true);
			expect(await scoped(() => claimSourceTemplateImageReview(jobId, role))).toBe(false);
			expect(
				await scoped(() =>
					recordSourceTemplateImageReview(jobId, role, {
						taskId,
						submissionUncertain: false,
						decision: {
							decision: "ALLOW",
							reasonCode: "ISOLATED_TEST_ALLOW",
							ruleVersion: VIDEO_V1_RULE_VERSION,
							evidence: {
								requestId: taskId,
								models: ["nsfw-filter-2"],
								operations: 1,
								scores: {},
								seeapi: { taskId, flagged: false, nsfw: [], specialCare: [] },
							},
						},
					}),
				),
			).toBe(true);
		}
	}
	async function approveFixtureInputReview(jobId: string) {
		const job = await client.generationJob.findUniqueOrThrow({ where: { id: jobId } });
		const snapshot = job.inputSnapshot as Record<string, unknown>;
		const profile = createVideoTextSafetyProfile();
		const requestId = `isolated-test-text-${crypto.randomUUID()}`;
		return scoped(() =>
			recordSourceTemplateInputReview(jobId, {
				status: "ALLOW",
				ruleVersion: VIDEO_V1_RULE_VERSION,
				requestFingerprint: snapshot.requestFingerprint,
				textSafetyProfile: profile,
				...(isProviderOwnedSourceTemplate(snapshot)
					? {
							textReviewNotApplicable: createSourceTemplateNoPromptReview(snapshot),
						}
					: {
							textDecision: {
								decision: "ALLOW",
								reasonCode: "WAFFO_PROMPT_ALLOWED",
								ruleVersion: profile.ruleVersion,
								evidence: {
									requestId,
									models: ["waffo-prompt-sift"],
									operations: 1,
									scores: {},
									waffo: {
										requestId,
										action: "allow",
										semanticStatus: "scored",
										matchedCategories: [],
									},
								},
							},
						}),
			}),
		);
	}
	function claimFixtureSubmission(jobId: string, f: Awaited<ReturnType<typeof fixture>>) {
		return scoped(() =>
			claimVideoProviderSubmission({
				jobId,
				callbackTokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
				providerModelId: f.request.sourceTemplate.transport.modelId,
				ruleVersion: VIDEO_V1_RULE_VERSION,
			}),
		);
	}
	async function preparedSpinJob() {
		const f = await fixture(2, 100n, "spin-me-round");
		const { jobId } = await createVideoJobRecord(f.createInput, client);
		await approveFixturePortraits(jobId, ["performer-1", "performer-2"]);
		expect(await approveFixtureInputReview(jobId)).toBe(true);
		return { ...f, jobId };
	}
	it("applies reviewed configuration bundles atomically with dry-run, replay and version fencing", async () => {
		const administratorId = `source-bundle-test-${crypto.randomUUID()}`;
		await client.user.create({
			data: {
				id: administratorId,
				name: "TEST ONLY ADMIN",
				email: `${administratorId}@example.invalid`,
				emailVerified: true,
				role: "admin",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const version = `fixture-bundle-${crypto.randomUUID()}`;
		const snapshot = { ...sourceHotelTemplateFixture().sourceTemplate, version };
		const value = {
			version,
			enabled: true,
			access: "authenticated",
			sourceConfig: {},
			references: [],
			prices: [
				{
					options: { resolution: "768P", aspectRatio: "9:16" },
					credits: "7",
					providerCostMicros: "1",
					moderationCostMicros: "1",
					pricingVersion: "TEST_ONLY",
					pricingBasis: "LOCAL SYNTHETIC TEST",
				},
			],
		};
		const configKey = sourceTemplateConfigKey("source-hotel-lobby");
		const input = {
			records: [{ configKey, value, validationSnapshot: snapshot }],
			bundleHash: "a".repeat(64),
			administratorId,
			reason: "ISOLATED LOCAL TEST ONLY",
			target: {
				environment: "local" as const,
				databaseIdentity: "ezpic_source_template_test",
				storageEndpoint: "http://127.0.0.1:59000",
				bucket: "video-v1-test",
			},
		};
		const before = await client.runtimeConfigOverride.count({ where: { configKey } });
		expect(
			await applySourceTemplateProvisionBundle({ ...input, dryRun: true }, client),
		).toMatchObject({ dryRun: true, replayed: false });
		expect(await client.runtimeConfigOverride.count({ where: { configKey } })).toBe(before);
		const [first, second] = await Promise.all([
			applySourceTemplateProvisionBundle(input, client),
			applySourceTemplateProvisionBundle(input, client),
		]);
		expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
		expect(first.records[0]!.id).toBe(second.records[0]!.id);
		expect(await client.runtimeConfigOverride.count({ where: { configKey } })).toBe(before + 1);
		expect(await client.auditLog.count({ where: { actorUserId: administratorId } })).toBe(1);
		const changed = { ...value, enabled: false };
		await expect(
			applySourceTemplateProvisionBundle(
				{ ...input, records: [{ ...input.records[0]!, value: changed, expectedVersion: null }] },
				client,
			),
		).rejects.toThrow("VIDEO_TEMPLATE_VERSION_CHANGED");
		await expect(
			applySourceTemplateProvisionBundle(
				{ ...input, administratorId: "not-an-administrator" },
				client,
			),
		).rejects.toThrow("VIDEO_ACCESS_DENIED");
		// All records are checked before any new override/audit is committed.
		const ordinary = await fixture(0);
		await expect(
			applySourceTemplateProvisionBundle(
				{
					...input,
					records: [
						{
							configKey: sourceTemplateConfigKey("original-rap"),
							value: { ...value, version: ordinary.request.sourceTemplate.version },
							validationSnapshot: ordinary.request.sourceTemplate,
						},
						{ ...input.records[0]!, value: changed, expectedVersion: null },
					],
				},
				client,
			),
		).rejects.toThrow("VIDEO_TEMPLATE_VERSION_CHANGED");
		expect(await client.auditLog.count({ where: { actorUserId: administratorId } })).toBe(1);
		const updated = await applySourceTemplateProvisionBundle(
			{
				...input,
				records: [
					{ ...input.records[0]!, value: changed, expectedVersion: first.records[0]!.version },
				],
			},
			client,
		);
		expect(updated.replayed).toBe(false);
		expect(await client.auditLog.count({ where: { actorUserId: administratorId } })).toBe(2);
	});
	it("admits hosted Hotel with null prompt/duration, requires both images and claims exactly once", async () => {
		const f = await fixture(2, 100n, "source-hotel-lobby");
		const { jobId } = await createVideoJobRecord(f.createInput, client);
		expect(f.request.prompt).toBeNull();
		expect(f.request.duration).toBeNull();
		await approveFixturePortraits(jobId, ["performer-1"]);
		await expect(approveFixtureInputReview(jobId)).rejects.toThrow("VIDEO_INPUT_REVIEW_REQUIRED");
		await approveFixturePortraits(jobId, ["performer-2"]);
		expect(await approveFixtureInputReview(jobId)).toBe(true);
		expect(await claimFixtureSubmission(jobId, f)).toMatchObject({ claimed: true });
		expect(await claimFixtureSubmission(jobId, f)).toMatchObject({ claimed: false });
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: jobId },
			include: { reservation: true, attempts: true, videoExecution: true },
		});
		expect(job.attempts).toHaveLength(1);
		expect(job.attempts[0]).toMatchObject({
			provider: "seeapi",
			providerModelId: "hotel-lobby-ai",
			uncertainSubmission: true,
		});
		expect(job.reservation).toMatchObject({ status: "ACTIVE", amount: 7n });
		expect(job.videoExecution?.stageData).toMatchObject({
			inputReview: { textReviewNotApplicable: { kind: "provider-owned-template/no-user-prompt" } },
		});
		expect(job.videoExecution!.stageData).not.toHaveProperty("inputReview.textDecision");
	});
	it("atomically binds both ordered private portraits, one shared reservation and native execution; replay survives closure and unknown submission", async () => {
		const f = await fixture();
		const result = await createVideoJobRecord(f.createInput, client);
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: result.jobId },
			include: {
				assets: { orderBy: { position: "asc" } },
				reservation: true,
				videoExecution: true,
				videoTemplateExecution: true,
			},
		});
		expect(job.assets.map((binding) => binding.assetId)).toEqual(f.assets.map((asset) => asset.id));
		expect(job.reservation).toMatchObject({ status: "ACTIVE", amount: 7n });
		expect(job.videoExecution).toMatchObject({ startState: "PENDING", stage: "QUEUED" });
		expect(job.videoTemplateExecution).toBeNull();
		expect(job.inputSnapshot).toMatchObject({
			sourceTemplate: { transport: f.request.sourceTemplate.transport },
			roleInputIdentities: [{ role: "performer-1" }, { role: "performer-2" }],
		});
		await client.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "seeapi",
				providerModelId: f.request.sourceTemplate.transport.modelId,
				requestSnapshot: f.request,
				status: "SUBMISSION_UNCERTAIN",
				uncertainSubmission: true,
			},
		});
		await client.runtimeConfigOverride.update({
			where: { id: f.configuration.id },
			data: { active: false },
		});
		expect(await createVideoJobRecord(f.createInput, client)).toEqual({
			jobId: job.id,
			replayed: true,
		});
		expect(
			(
				await findExistingVideoAdmission(
					{ ownerId: f.ownerId, request: f.request, idempotencyKey: f.createInput.idempotencyKey },
					client,
				)
			)?.id,
		).toBe(job.id);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});
	it("rejects foreign inputs before quotation", async () => {
		const f = await fixture();
		const request = structuredClone(f.request);
		request.sourceTemplate.request.inputs[1]!.assetId = (
			await client.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId: "another-account",
					kind: "INPUT",
					status: "VERIFYING",
					verificationEngine: "video-workflow-v1",
					objectKey: `test/foreign/${crypto.randomUUID()}`,
					mimeType: "image/png",
					byteSize: 100n,
					checksum: "a".repeat(64),
					storageEtag: "foreign",
					width: 100,
					height: 100,
					finalizedAt: new Date(),
				},
			})
		).id;
		await expect(createVideoQuoteRecord({ ...f.input, request }, client)).rejects.toThrow(
			"VIDEO_INPUT_NOT_AVAILABLE",
		);
		expect(await client.generationQuote.count({ where: { ownerId: f.ownerId } })).toBe(1);
	});
	it("closed or superseded configuration rejects an unused quote with no partial job/reservation", async () => {
		const f = await fixture();
		await client.runtimeConfigOverride.update({
			where: { id: f.configuration.id },
			data: { active: false },
		});
		await expect(createVideoJobRecord(f.createInput, client)).rejects.toThrow(
			"VIDEO_TEMPLATE_VERSION_CHANGED",
		);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
	it("swapping identities cannot consume an existing ordered quote", async () => {
		const f = await fixture();
		const request = structuredClone(f.request);
		request.inputAssetId = f.assets[1]!.id;
		request.sourceTemplate.request.inputs[0]!.assetId = f.assets[1]!.id;
		request.sourceTemplate.request.inputs[1]!.assetId = f.assets[0]!.id;
		await expect(createVideoJobRecord({ ...f.createInput, request }, client)).rejects.toThrow(
			"VIDEO_QUOTE_INPUT_MISMATCH",
		);
	});
	it("text-only original Rap has no input binding or generated scene", async () => {
		const f = await fixture(0);
		const result = await createVideoJobRecord(f.createInput, client);
		expect(await client.generationJobAsset.count({ where: { jobId: result.jobId } })).toBe(0);
		expect(await client.videoTemplateExecution.count({ where: { jobId: result.jobId } })).toBe(0);
	});
	it("insufficient shared credits rolls back output capacity, job and execution intent", async () => {
		const f = await fixture(0, 1n);
		await expect(createVideoJobRecord(f.createInput, client)).rejects.toThrow();
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.storageUsageReservation.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
	it("uses the preserved Spin scene first and claims only once after every portrait review", async () => {
		const f = await fixture(2, 100n, "spin-me-round");
		const { jobId } = await createVideoJobRecord(f.createInput, client);
		expect(f.request.sourceTemplate.transport.body).toMatchObject({
			input: {
				reference_images: [
					"https://ezpic-template.example/reference/0",
					"https://ezpic-template.example/user/performer-1",
					"https://ezpic-template.example/user/performer-2",
				],
			},
		});
		await approveFixturePortraits(jobId, ["performer-1"]);
		await expect(approveFixtureInputReview(jobId)).rejects.toThrow("VIDEO_INPUT_REVIEW_REQUIRED");
		await expect(claimFixtureSubmission(jobId, f)).rejects.toThrow("VIDEO_INPUT_REVIEW_REQUIRED");
		expect(await client.generationAttempt.count({ where: { jobId } })).toBe(0);
		await approveFixturePortraits(jobId, ["performer-2"]);
		expect(await approveFixtureInputReview(jobId)).toBe(true);
		const first = await claimFixtureSubmission(jobId, f);
		if (!("attempt" in first)) throw new Error("UNEXPECTED_TEST_DISPATCH_DEFERRAL");
		expect(first).toMatchObject({
			claimed: true,
			attempt: {
				provider: f.request.sourceTemplate.transport.provider,
				providerModelId: f.request.sourceTemplate.transport.modelId,
				uncertainSubmission: true,
				status: "SUBMISSION_UNCERTAIN",
				requestSnapshot: { sourceTemplate: f.request.sourceTemplate },
			},
		});
		expect(await claimFixtureSubmission(jobId, f)).toMatchObject({
			claimed: false,
			attempt: { id: first.attempt.id },
		});
		expect(await client.generationAttempt.count({ where: { jobId } })).toBe(1);
		expect(await client.videoTemplateExecution.count({ where: { jobId } })).toBe(0);
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: f.account.id } }),
		).toMatchObject({
			spendableCredits: 93n,
			reservedCredits: 7n,
		});
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});
	it.each(["replaced-object", "expired-material"] as const)(
		"rechecks the private scene before dispatch: %s cannot create an attempt",
		async (mutation) => {
			const f = await preparedSpinJob();
			const reference = f.request.sourceTemplate.references[0]!;
			if (mutation === "replaced-object") {
				await client.mediaAsset.update({
					where: { id: reference.assetId },
					data: { status: "VERIFYING" },
				});
				await client.mediaAsset.update({
					where: { id: reference.assetId },
					data: { storageEtag: "isolated-test-replacement" },
				});
				await client.mediaAsset.update({
					where: { id: reference.assetId },
					data: { status: "READY" },
				});
			} else {
				await client.mediaAsset.update({
					where: { id: reference.assetId },
					data: { deleteAfter: new Date(Date.now() - 60_000) },
				});
			}
			await expect(claimFixtureSubmission(f.jobId, f)).rejects.toThrow(
				"VIDEO_SOURCE_TEMPLATE_REFERENCE_IDENTITY_CHANGED",
			);
			expect(await client.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(0);
			expect(
				await client.creditReservation.findUniqueOrThrow({ where: { jobId: f.jobId } }),
			).toMatchObject({ status: "ACTIVE", amount: 7n });
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		},
	);
	it("definite source-provider rejection releases the shared reservation exactly once", async () => {
		const f = await preparedSpinJob();
		expect(await claimFixtureSubmission(f.jobId, f)).toMatchObject({ claimed: true });
		expect(
			await scoped(() =>
				failVideoExecution(f.jobId, "ISOLATED_TEST_DEFINITE_REJECTION", false, true),
			),
		).toBe(true);
		expect(
			await scoped(() =>
				failVideoExecution(f.jobId, "ISOLATED_TEST_DEFINITE_REJECTION", false, true),
			),
		).toBe(false);
		expect(
			await client.creditReservation.findUniqueOrThrow({ where: { jobId: f.jobId } }),
		).toMatchObject({ status: "RELEASED", amount: 7n, releasedAmount: 7n, settledAmount: 0n });
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: f.account.id } }),
		).toMatchObject({ spendableCredits: 100n, reservedCredits: 0n });
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RELEASE" } }),
		).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "SETTLE" } }),
		).toBe(0);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});
	it("unknown source submission keeps credits reserved and retains the same attempt after reference expiry", async () => {
		const f = await preparedSpinJob();
		const first = await claimFixtureSubmission(f.jobId, f);
		if (!("attempt" in first)) throw new Error("UNEXPECTED_TEST_DISPATCH_DEFERRAL");
		await scoped(() => markVideoSubmissionUncertain(f.jobId, "ISOLATED_TEST_RESPONSE_LOST"));
		await client.mediaAsset.update({
			where: { id: f.request.sourceTemplate.references[0]!.assetId },
			data: { deleteAfter: new Date(Date.now() - 60_000) },
		});
		expect(await scoped(() => failVideoExecution(f.jobId, "ISOLATED_TEST_NETWORK_FAILURE"))).toBe(
			false,
		);
		expect(await claimFixtureSubmission(f.jobId, f)).toMatchObject({
			claimed: false,
			attempt: { id: first.attempt.id, uncertainSubmission: true },
		});
		expect(await createVideoJobRecord(f.createInput, client)).toEqual({
			jobId: f.jobId,
			replayed: true,
		});
		expect(await client.generationJob.findUniqueOrThrow({ where: { id: f.jobId } })).toMatchObject({
			status: "NEEDS_RECONCILIATION",
		});
		expect(await client.generationAttempt.count({ where: { jobId: f.jobId } })).toBe(1);
		expect(
			await client.creditReservation.findUniqueOrThrow({ where: { jobId: f.jobId } }),
		).toMatchObject({ status: "ACTIVE", amount: 7n, settledAmount: 0n, releasedAmount: 0n });
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: f.account.id } }),
		).toMatchObject({ spendableCredits: 93n, reservedCredits: 7n });
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(1);
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: f.account.id, type: { in: ["RELEASE", "SETTLE"] } },
			}),
		).toBe(0);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});
});
