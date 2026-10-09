import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoEffectTemplateSnapshot } from "@repo/config/video-effects.server";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { VIDEO_V1_POLICY_VERSION, VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWithDatabaseClient } from "../../client";
import type { Prisma } from "../../generated/client";
import { PrismaClient } from "../../generated/client";
import { markMediaAssetDeletedTransaction } from "./assets";
import { createCreditGrant, releaseCredits, reserveCredits } from "./credits";
import {
	authorizeVideoPlayback,
	beginVideoReviewSubmission,
	claimVideoAudioStep,
	recordVideoAudioTranscript,
	recordVideoAudioDecision,
	claimVideoOutputReview,
	claimVideoOutputStorage,
	completeVideoOutputStorage,
	failVideoDelivery,
	finalizeVideoDelivery,
	hasVideoApproval,
	recordVideoOutputReview,
	recordVideoReviewTask,
	releaseVideoReviewLease,
	releaseVideoStorageLease,
} from "./video-v1-fulfillment";
import {
	claimSeeapiVideoConfirmation,
	persistSeeapiVideoModerationWebhook,
	recordSeeapiVideoConfirmation,
} from "./video-v1-seeapi-events";

describe("video V1 fulfillment isolated database", () => {
	let client: PrismaClient;
	const fixtureOwners: string[] = [];
	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("BLOCKED: explicit TEST_DATABASE_URL required");
		const url = new URL(connectionString);
		if (
			!["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
			!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1))
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 12 }) });
	});
	afterAll(async () => {
		if (!client) return;
		try {
			// Only identities created by this test invocation are eligible. These
			// fixtures never sent an external request; retain the immutable ledger
			// and append a normal release for any deliberately unresolved scenario.
			const jobs = await client.generationJob.findMany({
				where: {
					ownerType: "USER",
					ownerId: { in: fixtureOwners },
					executionEngine: "video-workflow-v1",
				},
				include: { reservation: true },
			});
			for (const job of jobs) {
				if (job.reservation?.status === "ACTIVE")
					await releaseCredits(
						{
							reservationId: job.reservation.id,
							referenceKey: `isolated-test-cleanup:${job.id}`,
						},
						client,
					);
				if (!["SUCCEEDED", "FAILED", "CANCELED"].includes(job.status)) {
					await client.videoExecution.updateMany({
						where: { jobId: job.id },
						data: { stage: "FAILED", needsReviewReason: "ISOLATED_TEST_CLEANUP" },
					});
					await client.generationJob.update({
						where: { id: job.id },
						data: {
							status: "FAILED",
							failureCode: "ISOLATED_TEST_CLEANUP",
							terminalAt: new Date(),
						},
					});
				}
			}
			await client.storageUsageReservation.updateMany({
				where: { ownerType: "USER", ownerId: { in: fixtureOwners }, status: "ACTIVE" },
				data: { status: "RELEASED", releasedAt: new Date() },
			});
			expect(
				await client.creditReservation.count({
					where: { status: "ACTIVE", job: { ownerId: { in: fixtureOwners } } },
				}),
			).toBe(0);
			expect(
				await client.generationJob.count({
					where: {
						ownerId: { in: fixtureOwners },
						status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] },
					},
				}),
			).toBe(0);
		} finally {
			await client.$disconnect();
		}
	});
	const scoped = <T>(fn: () => Promise<T>) => runWithDatabaseClient(client, fn);
	async function fixture(inputSnapshot: Prisma.InputJsonObject = { duration: 5 }) {
		const ownerId = `video-fulfillment-test-${crypto.randomUUID()}`;
		fixtureOwners.push(ownerId);
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		await createCreditGrant(
			{ accountId: account.id, amount: 100n, referenceKey: `grant:${ownerId}` },
			client,
		);
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKey: "video-kling-2-6-v1",
				catalogVersion: "TEST",
				pricingVersion: "TEST_ONLY",
				credits: 7n,
				costMicros: 1n,
				inputSnapshot,
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
				productKey: "video-kling-2-6-v1",
				catalogVersion: "TEST",
				pricingVersion: "TEST_ONLY",
				creditsReserved: 7n,
				inputSnapshot,
				pricingSnapshot: {},
				executionEngine: "video-workflow-v1",
				status: "FINALIZING",
			},
		});
		await client.videoExecution.create({
			data: {
				jobId: job.id,
				workflowInstanceId: `video-v1-${job.id}`,
				stage: "STORING",
				modelContractVersion: "TEST",
			},
		});
		await reserveCredits(
			{ accountId: account.id, jobId: job.id, amount: 7n, referenceKey: `reserve:${job.id}` },
			client,
		);
		await client.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: "kling-2.6/text-to-video",
				providerTaskId: crypto.randomUUID(),
				status: "SUCCEEDED",
				providerCostMicros: 100n,
				requestSnapshot: {},
				transferEnvelope: {
					create: {
						payload: {
							schemaVersion: 1,
							authority: "authenticated-query",
							outputUrl: "https://cdn.video.test/output.mp4",
						},
					},
				},
			},
		});
		return { jobId: job.id, ownerId, accountId: account.id };
	}
	async function stored(
		jobId: string,
		extra: {
			bytes?: number;
			durationMillis?: number;
			audioTracks?: number;
			audioTrackIds?: number[];
		} = {},
	) {
		const claim = await scoped(() => claimVideoOutputStorage(jobId, 200_000_000n));
		if (!claim.token) throw new Error("claim required");
		const output = {
			bytes: 1000,
			checksum: "a".repeat(64),
			etag: "etag-video",
			durationMillis: 5000,
			width: 1280,
			height: 720,
			audioTracks: 0 as const,
			videoTracks: 1 as const,
			...extra,
		};
		await scoped(() => completeVideoOutputStorage(jobId, claim.asset.id, claim.token!, output));
		return {
			assetId: claim.asset.id,
			checksum: output.checksum,
			etag: output.etag,
			checkedAt: new Date(),
		};
	}
	async function approved(jobId: string) {
		const object = await stored(jobId);
		const submit = await scoped(() => claimVideoOutputReview(jobId, 1800));
		await scoped(() => recordVideoReviewTask(object.assetId, submit.token!, crypto.randomUUID()));
		const query = await scoped(() => claimVideoOutputReview(jobId, 1800));
		await scoped(() =>
			recordVideoOutputReview({
				jobId,
				...object,
				token: query.token!,
				decision: "ALLOW",
				reasonCode: "NO_POLICY_MATCH",
				complete: true,
				evidence: { video: { complete: true, frameCount: 10 } },
			}),
		);
		return object;
	}
	function seeapiEvidence(taskId: string) {
		return {
			requestId: taskId,
			models: ["video-nsfw-filter"],
			operations: 1,
			scores: {},
			video: {
				complete: true,
				durationMillis: 5000,
				frameCount: 8,
				firstFrameSeconds: 0,
				lastFrameSeconds: 4.9,
			},
			seeapiVideo: {
				taskId,
				model: "video-nsfw-filter",
				scope: "sampled_frames",
				samplingComplete: true,
				requestedFrames: 8,
				checkedFrames: 8,
				timestampSource: "frame_index_div_fps_estimate",
				reportSchemaVersion: 5,
				thresholdOffset: 0,
				strictSpecialCare: true,
				returnFrames: "none",
				flagged: false,
				flaggedFrameCount: 0,
				nsfw: [],
				specialCareReportedFrames: 0,
				maxFrameGapSeconds: 0.7,
			},
		};
	}
	async function confirmed(
		jobId: string,
		assetId: string,
		taskId: string,
		evidence = seeapiEvidence(taskId),
	) {
		const asset = await client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
		const rawBody = '{"callback":"verified-fixture"}';
		await scoped(() =>
			persistSeeapiVideoModerationWebhook({
				assetId,
				generation: asset.verificationGeneration,
				attemptNumber: asset.verificationAttemptCount,
				rawBody,
				eventHash: createHash("sha256").update(rawBody).digest("hex"),
				receivedAt: new Date(),
			}),
		);
		const claim = await scoped(() => claimSeeapiVideoConfirmation(jobId));
		if (claim.status !== "CLAIMED") throw new Error("CONFIRMATION_CLAIM_REQUIRED");
		await scoped(() =>
			recordSeeapiVideoConfirmation({
				jobId,
				eventId: claim.eventId,
				token: claim.token,
				decision: {
					decision: "ALLOW",
					reasonCode: "NO_POLICY_MATCH",
					ruleVersion: createVideoVisualSafetyProfile("seeapi", 5).ruleVersion,
					evidence,
				},
			}),
		);
	}
	it.each(["ordinary", "hotel-lobby-duo", "raindance-solo"] as const)(
		"records quality differences for %s but requires actual-duration NSFW evidence and settles once",
		async (kind) => {
			const template =
				kind === "ordinary"
					? null
					: createVideoEffectTemplateSnapshot({
							effectId: kind,
							presetKey: "standard",
							inputs: {
								leftAssetId: "left",
								rightAssetId: kind === "raindance-solo" ? "left" : "right",
							},
						});
			const item = await fixture({
				...(template
					? {
							...template.video,
							requestKind: "template-video",
							videoEffectTemplate: template,
							roleInputIdentities: [{ role: "left" }, { role: "right" }],
						}
					: {
							productKey: "video-kling-3",
							duration: 5,
							sound: false,
							resolution: "1080p",
							aspectRatio: "9:16",
						}),
				visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
				audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
			});
			if (template)
				await client.videoTemplateExecution.create({
					data: {
						jobId: item.jobId,
						templateSnapshot: template,
						orderedRoleIdentities: [{ role: "left" }, { role: "right" }],
						sceneState: "READY",
					},
				});
			const output = await stored(item.jobId, {
				durationMillis: 6000,
				audioTracks: 1,
				audioTrackIds: [2],
			});
			const execution = await client.videoExecution.findUniqueOrThrow({
				where: { jobId: item.jobId },
			});
			expect(execution.stageData).toMatchObject({
				outputSpec: {
					assetId: output.assetId,
					checksum: output.checksum,
					etag: output.etag,
					report: {
						actual: { durationMillis: 6000, width: 1280, height: 720, audioTracks: 1 },
						requested: { durationSeconds: 5, sound: false, aspectRatio: "9:16" },
						warnings: [
							"DURATION_MISMATCH",
							"UNEXPECTED_AUDIO",
							"RESOLUTION_MISMATCH",
							"ASPECT_RATIO_MISMATCH",
						],
					},
				},
			});
			expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).toBeNull();
			await expect(
				scoped(() => finalizeVideoDelivery(item.jobId, { ...output, checkedAt: new Date() })),
			).rejects.toThrow("VIDEO_DELIVERY_PRECONDITION_FAILED");
			const submit = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
			expect(submit.reviewContext).toMatchObject({
				durationMillis: 6000,
				constraints: { durationSeconds: 5, sound: false, aspectRatio: "9:16" },
				outputSpec: { audioTracks: 1, audioTrackIds: [2], durationMillis: 6000 },
			});
			expect(submit.asset).toMatchObject({
				ownerId: item.ownerId,
				ownerType: "USER",
				verificationEngine: "video-workflow-v1",
				verificationLeaseToken: submit.token,
			});
			expect(submit.asset.verificationDeadlineAt).toBeInstanceOf(Date);
			const taskId = `quality_${crypto.randomUUID()}`;
			await scoped(() => beginVideoReviewSubmission(output.assetId, submit.token!));
			await scoped(() => recordVideoReviewTask(output.assetId, submit.token!, taskId));
			const evidence = seeapiEvidence(taskId);
			evidence.video.durationMillis = 6000;
			evidence.video.lastFrameSeconds = 5.9;
			evidence.seeapiVideo.maxFrameGapSeconds = 0.9;
			await confirmed(item.jobId, output.assetId, taskId, evidence);
			const query = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
			const review = {
				jobId: item.jobId,
				...output,
				token: query.token!,
				decision: "ALLOW" as const,
				reasonCode: "NO_POLICY_MATCH",
				complete: true,
				evidence,
			};
			// A report covering only the requested five seconds does not clear this six-second file.
			await expect(
				scoped(() => recordVideoOutputReview({ ...review, evidence: seeapiEvidence(taskId) })),
			).rejects.toThrow();
			await expect(
				scoped(() =>
					recordVideoOutputReview({
						...review,
						evidence: { ...evidence, video: { ...evidence.video, lastFrameSeconds: 4.9 } },
					}),
				),
			).rejects.toThrow();
			await scoped(() => recordVideoOutputReview(review));
			await Promise.all(
				Array.from({ length: 5 }, () =>
					scoped(() => finalizeVideoDelivery(item.jobId, { ...output, checkedAt: new Date() })),
				),
			);
			const job = await client.generationJob.findUniqueOrThrow({
				where: { id: item.jobId },
				include: { reservation: true, videoExecution: true },
			});
			expect(job).toMatchObject({
				status: "SUCCEEDED",
				failureCode: null,
				reservation: { status: "SETTLED" },
				videoExecution: { stage: "READY" },
			});
			expect(
				await client.creditLedgerEntry.count({
					where: { accountId: item.accountId, type: "SETTLE" },
				}),
			).toBe(1);
			expect(
				await client.creditLedgerEntry.count({
					where: { accountId: item.accountId, type: "RELEASE" },
				}),
			).toBe(0);
			expect(await client.generationAttempt.count({ where: { jobId: item.jobId } })).toBe(1);
			expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).toMatchObject({
				id: output.assetId,
				checksum: output.checksum,
				durationMillis: 6000n,
			});
			expect(await scoped(() => authorizeVideoPlayback("other-owner", item.jobId))).toBeNull();
		},
	);
	it("allows a shorter usable output only after complete NSFW evidence covers its actual duration", async () => {
		const item = await fixture({
			productKey: "video-kling-3",
			duration: 5,
			sound: false,
			resolution: "720p",
			aspectRatio: "16:9",
			visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
			audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
		});
		const output = await stored(item.jobId, { durationMillis: 1000 });
		const submit = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		const taskId = `short_${crypto.randomUUID()}`;
		await scoped(() => beginVideoReviewSubmission(output.assetId, submit.token!));
		await scoped(() => recordVideoReviewTask(output.assetId, submit.token!, taskId));
		const evidence = seeapiEvidence(taskId);
		evidence.video.durationMillis = 1000;
		evidence.video.lastFrameSeconds = 0.9;
		evidence.seeapiVideo.maxFrameGapSeconds = 0.13;
		await confirmed(item.jobId, output.assetId, taskId, evidence);
		const query = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await scoped(() =>
			recordVideoOutputReview({
				jobId: item.jobId,
				...output,
				token: query.token!,
				decision: "ALLOW",
				reasonCode: "NO_POLICY_MATCH",
				complete: true,
				evidence,
			}),
		);
		expect(
			await scoped(() => finalizeVideoDelivery(item.jobId, { ...output, checkedAt: new Date() })),
		).toMatchObject({ stage: "READY" });
		expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).toMatchObject({
			durationMillis: 1000n,
		});
	});
	it("does not revive or charge a historical failed/released result", async () => {
		const item = await fixture();
		const output = await stored(item.jobId);
		await scoped(() => failVideoDelivery(item.jobId, "VIDEO_RESOLUTION_MISMATCH"));
		expect(
			await scoped(() => finalizeVideoDelivery(item.jobId, { ...output, checkedAt: new Date() })),
		).toMatchObject({ stage: "FAILED" });
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: item.accountId, type: "SETTLE" },
			}),
		).toBe(0);
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: item.accountId, type: "RELEASE" },
			}),
		).toBe(1);
		expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).toBeNull();
	});
	it("binds SeeAPI task/profile evidence and rejects legacy or incomplete samples before settlement", async () => {
		const profile = createVideoVisualSafetyProfile("seeapi", 5);
		const item = await fixture({ duration: 5, visualSafetyProfile: profile });
		const output = await stored(item.jobId);
		const submit = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		expect(submit.asset).toMatchObject({
			verificationProvider: "seeapi",
			verificationRuleVersion: profile.ruleVersion,
			verificationPolicyVersion: profile.policyVersion,
		});
		const taskId = `task_${crypto.randomUUID()}`;
		await scoped(() => beginVideoReviewSubmission(output.assetId, submit.token!));
		await scoped(() => recordVideoReviewTask(output.assetId, submit.token!, taskId));
		const query = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		const evidence = seeapiEvidence(taskId);
		const input = {
			jobId: item.jobId,
			...output,
			token: query.token!,
			decision: "ALLOW" as const,
			reasonCode: "NO_POLICY_MATCH",
			complete: true,
			evidence,
		};
		await expect(scoped(() => recordVideoOutputReview(input))).rejects.toThrow(
			"VIDEO_SEEAPI_CALLBACK_CONFIRMATION_REQUIRED",
		);
		await confirmed(item.jobId, output.assetId, taskId);
		await expect(
			scoped(() => recordVideoOutputReview({ ...input, evidence: { video: evidence.video } })),
		).rejects.toThrow("VIDEO_VISUAL_PROFILE_EVIDENCE_REQUIRED");
		await expect(
			scoped(() =>
				recordVideoOutputReview({
					...input,
					evidence: {
						...evidence,
						seeapiVideo: { ...evidence.seeapiVideo, maxFrameGapSeconds: 1.01 },
					},
				}),
			),
		).rejects.toThrow("VIDEO_VISUAL_PROFILE_EVIDENCE_REQUIRED");
		expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).toBeNull();
		await scoped(() => recordVideoOutputReview(input));
		expect(
			(await scoped(() => finalizeVideoDelivery(item.jobId, { ...output, checkedAt: new Date() })))
				.stage,
		).toBe("READY");
		expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).not.toBeNull();
		const review = await client.assetModerationResult.findFirstOrThrow({
			where: { assetId: output.assetId },
		});
		expect(review).toMatchObject({
			provider: "seeapi",
			providerTaskId: taskId,
			ruleVersion: profile.ruleVersion,
			policyVersion: profile.policyVersion,
		});
		expect(review.rawEnvelope).toMatchObject({
			visualSafetyProfile: profile,
			objectEtag: output.etag,
		});
	});
	it("does not overwrite a conflicting provider identity while an original task is running", async () => {
		const item = await fixture({
			duration: 5,
			visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
		});
		const output = await stored(item.jobId);
		await client.mediaAsset.update({
			where: { id: output.assetId },
			data: {
				verificationProvider: "sightengine",
				verificationRuleVersion: VIDEO_V1_RULE_VERSION,
				verificationPolicyVersion: VIDEO_V1_POLICY_VERSION,
				verificationProviderTaskId: "med_original",
			},
		});
		await expect(scoped(() => claimVideoOutputReview(item.jobId, 1800))).rejects.toThrow(
			"VIDEO_VISUAL_PROFILE_IDENTITY_CHANGED",
		);
		expect(
			await client.mediaAsset.findUniqueOrThrow({ where: { id: output.assetId } }),
		).toMatchObject({
			verificationProvider: "sightengine",
			verificationProviderTaskId: "med_original",
		});
	});
	it("SeeAPI visual approval alone cannot authorize audible output", async () => {
		const item = await fixture({
			productKey: "video-kling-3",
			duration: 5,
			resolution: "720p",
			aspectRatio: "16:9",
			sound: true,
			visualSafetyProfile: createVideoVisualSafetyProfile("seeapi", 5),
		});
		const output = await stored(item.jobId, { audioTracks: 1, audioTrackIds: [2] });
		const submit = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await scoped(() => beginVideoReviewSubmission(output.assetId, submit.token!));
		await scoped(() => recordVideoReviewTask(output.assetId, submit.token!, "task_speech"));
		await confirmed(item.jobId, output.assetId, "task_speech");
		const query = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await expect(
			scoped(() =>
				recordVideoOutputReview({
					jobId: item.jobId,
					...output,
					token: query.token!,
					decision: "ALLOW",
					reasonCode: "NO_POLICY_MATCH",
					complete: true,
					evidence: seeapiEvidence("task_speech"),
				}),
			),
		).rejects.toThrow("VIDEO_AUDIO_MODERATION_REQUIRED");
		expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).toBeNull();
		expect(
			(await client.creditReservation.findUniqueOrThrow({ where: { jobId: item.jobId } })).status,
		).toBe("ACTIVE");
	});
	it("settles native audio under the frozen not-requested policy without audio evidence or the historical ASR size cap", async () => {
		const profile = createVideoVisualSafetyProfile("seeapi", 5);
		const item = await fixture({
			productKey: "video-kling-3",
			duration: 5,
			resolution: "720p",
			aspectRatio: "16:9",
			sound: true,
			visualSafetyProfile: profile,
			audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
		});
		const output = await stored(item.jobId, {
			bytes: 30_000_000,
			audioTracks: 1,
			audioTrackIds: [2],
		});
		const submit = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await scoped(() => beginVideoReviewSubmission(output.assetId, submit.token!));
		await scoped(() => recordVideoReviewTask(output.assetId, submit.token!, "task_native_audio"));
		await confirmed(item.jobId, output.assetId, "task_native_audio");
		const query = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await scoped(() =>
			recordVideoOutputReview({
				jobId: item.jobId,
				...output,
				token: query.token!,
				decision: "ALLOW",
				reasonCode: "NO_POLICY_MATCH",
				complete: true,
				evidence: seeapiEvidence("task_native_audio"),
			}),
		);
		expect(
			(await scoped(() => finalizeVideoDelivery(item.jobId, { ...output, checkedAt: new Date() })))
				.stage,
		).toBe("READY");
		expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).not.toBeNull();
		const review = await client.assetModerationResult.findFirstOrThrow({
			where: { assetId: output.assetId },
		});
		expect(review.rawEnvelope).toMatchObject({
			audioSafetyPolicy: { schemaVersion: 1, mode: "not_requested" },
		});
		expect((review.rawEnvelope as Prisma.JsonObject).audio).toBeUndefined();
		expect(
			(
				(await client.videoExecution.findUniqueOrThrow({ where: { jobId: item.jobId } }))
					.stageData as Prisma.JsonObject
			).audioReview,
		).toBeUndefined();
	});
	it("requires durable speech review for the same audio track and duration before settlement or playback", async () => {
		const item = await fixture({
			productKey: "video-kling-3",
			mode: "text-to-video",
			duration: 10,
			resolution: "720p",
			aspectRatio: "16:9",
			sound: true,
		});
		const output = await stored(item.jobId, {
			durationMillis: 10_000,
			audioTracks: 1,
			audioTrackIds: [2],
		});
		const submit = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await scoped(() => recordVideoReviewTask(output.assetId, submit.token!, crypto.randomUUID()));
		const query = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		const input = {
			jobId: item.jobId,
			...output,
			token: query.token!,
			decision: "ALLOW" as const,
			reasonCode: "NO_POLICY_MATCH",
			complete: true,
			evidence: { video: { complete: true, durationMillis: 10_000 } },
		};
		await expect(scoped(() => recordVideoOutputReview(input))).rejects.toThrow(
			"VIDEO_AUDIO_MODERATION_REQUIRED",
		);
		await expect(
			scoped(() =>
				recordVideoOutputReview({
					...input,
					evidence: { video: { complete: true, durationMillis: 5000 } },
				}),
			),
		).rejects.toThrow("VIDEO_FULL_DURATION_MODERATION_REQUIRED");
		expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).toBeNull();
		const transcribe = await scoped(() => claimVideoAudioStep(item.jobId, "transcribe"));
		if (transcribe.status !== "CLAIMED") throw new Error("ASR claim required");
		expect((await scoped(() => claimVideoAudioStep(item.jobId, "transcribe"))).status).toBe("BUSY");
		await scoped(() =>
			recordVideoAudioTranscript(item.jobId, transcribe.token, {
				text: "Local fixture speech",
				language: "english",
				durationMillis: 10_000,
				audioTrackId: 2,
				checksum: output.checksum,
			}),
		);
		expect((await scoped(() => claimVideoAudioStep(item.jobId, "transcribe"))).status).toBe(
			"TRANSCRIBED",
		);
		const moderate = await scoped(() => claimVideoAudioStep(item.jobId, "moderate"));
		if (moderate.status !== "CLAIMED") throw new Error("policy claim required");
		const audio = {
			complete: true,
			trackIds: [2],
			durationMillis: 10_000,
			language: "english",
			transcriptModerated: true,
			policyVersion: "video-spoken-content-2026-10-04.1",
		};
		await scoped(() =>
			recordVideoAudioDecision(item.jobId, moderate.token, {
				decision: "ALLOW",
				evidence: { audio },
			}),
		);
		await expect(
			scoped(() =>
				recordVideoOutputReview({
					...input,
					evidence: { ...input.evidence, audio: { ...audio, trackIds: [99] } },
				}),
			),
		).rejects.toThrow("VIDEO_AUDIO_MODERATION_REQUIRED");
		await scoped(() =>
			recordVideoOutputReview({ ...input, evidence: { ...input.evidence, audio } }),
		);
		expect(
			(await scoped(() => finalizeVideoDelivery(item.jobId, { ...output, checkedAt: new Date() })))
				.stage,
		).toBe("READY");
		expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).not.toBeNull();
		const execution = await client.videoExecution.findUniqueOrThrow({
			where: { jobId: item.jobId },
		});
		expect(
			(execution.stageData as { audioReview: { transcript: unknown } }).audioReview.transcript,
		).toBeNull();
	});
	it("an expired ASR send fence remains uncertain and cannot send again", async () => {
		const item = await fixture({
			productKey: "video-kling-3",
			mode: "text-to-video",
			duration: 10,
			resolution: "720p",
			aspectRatio: "16:9",
			sound: true,
		});
		await stored(item.jobId, { durationMillis: 10_000, audioTracks: 1, audioTrackIds: [2] });
		const first = await scoped(() => claimVideoAudioStep(item.jobId, "transcribe"));
		if (first.status !== "CLAIMED") throw new Error("ASR claim required");
		const execution = await client.videoExecution.findUniqueOrThrow({
			where: { jobId: item.jobId },
		});
		const data = execution.stageData as Record<string, Record<string, string | number | null>>;
		await client.videoExecution.update({
			where: { jobId: item.jobId },
			data: {
				stageData: {
					...data,
					audioReview: { ...data.audioReview, leasedUntil: new Date(0).toISOString() },
				},
			},
		});
		expect((await scoped(() => claimVideoAudioStep(item.jobId, "transcribe"))).status).toBe(
			"UNCERTAIN",
		);
		expect((await scoped(() => claimVideoAudioStep(item.jobId, "moderate"))).status).toBe(
			"UNCERTAIN",
		);
	});
	it("does not mark local output inspection as an uncertain paid moderation submission", async () => {
		const item = await fixture();
		await stored(item.jobId);
		const claim = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		expect(claim.status).toBe("SUBMIT");
		expect(claim.reviewContext).toMatchObject({
			durationMillis: 5000,
			audioSafetyPolicy: { schemaVersion: 1, mode: "required" },
			outputSpec: { audioTracks: 0 },
		});
		expect(claim.asset.verificationLeaseToken).toBe(claim.token);
		expect(claim.asset.verificationDeadlineAt).toBeInstanceOf(Date);
		expect(claim.asset.verificationSubmissionUncertain).toBe(false);
		const busy = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		expect(busy.status).toBe("BUSY");
		expect(busy.reviewContext).toEqual(claim.reviewContext);
		expect(busy.asset.verificationLeasedUntil).toEqual(claim.asset.verificationLeasedUntil);
		await scoped(() => releaseVideoReviewLease(claim.asset.id, claim.token!));
		const retry = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		expect(retry.status).toBe("SUBMIT");
		await scoped(() => beginVideoReviewSubmission(retry.asset.id, retry.token!));
		expect((await scoped(() => claimVideoOutputReview(item.jobId, 1800))).status).toBe("BUSY");
		await expect(
			scoped(() => beginVideoReviewSubmission(retry.asset.id, retry.token!)),
		).rejects.toThrow("VIDEO_REVIEW_SUBMISSION_FENCE_UNAVAILABLE");
		await scoped(() => releaseVideoReviewLease(retry.asset.id, retry.token!));
		const uncertain = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		expect(uncertain.status).toBe("UNCERTAIN");
		expect(uncertain.reviewContext).toEqual(claim.reviewContext);
	});
	it("twenty finalizers settle once and a late failure cannot release or override READY", async () => {
		const fixtureData = await fixture();
		const object = await approved(fixtureData.jobId);
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				scoped(() =>
					finalizeVideoDelivery(fixtureData.jobId, { ...object, checkedAt: new Date() }),
				),
			),
		);
		expect(results.every((result) => result.stage === "READY")).toBe(true);
		expect((await scoped(() => failVideoDelivery(fixtureData.jobId, "LATE_FAILURE"))).stage).toBe(
			"READY",
		);
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: fixtureData.accountId, type: "SETTLE" },
			}),
		).toBe(1);
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: fixtureData.accountId, type: "RELEASE" },
			}),
		).toBe(0);
		expect(
			await scoped(() => authorizeVideoPlayback(fixtureData.ownerId, fixtureData.jobId)),
		).not.toBeNull();
		expect(await scoped(() => authorizeVideoPlayback("other-owner", fixtureData.jobId))).toBeNull();
	});
	it("success/failure race produces exactly one terminal financial outcome", async () => {
		const item = await fixture();
		const object = await approved(item.jobId);
		await Promise.all([
			scoped(() => finalizeVideoDelivery(item.jobId, { ...object, checkedAt: new Date() })),
			scoped(() => failVideoDelivery(item.jobId, "DEFINITE_PROVIDER_FAILURE")),
		]);
		const rows = await client.creditLedgerEntry.findMany({
			where: { accountId: item.accountId, type: { in: ["SETTLE", "RELEASE"] } },
		});
		expect(rows).toHaveLength(1);
		expect(
			(await client.generationAttempt.findFirstOrThrow({ where: { jobId: item.jobId } }))
				.providerCostMicros,
		).toBe(100n);
	});
	it("partial moderation cannot settle; uncertain submissions retain the reservation", async () => {
		const item = await fixture();
		const object = await stored(item.jobId);
		const submit = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await scoped(() => recordVideoReviewTask(object.assetId, submit.token!, crypto.randomUUID()));
		const query = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await expect(
			scoped(() =>
				recordVideoOutputReview({
					jobId: item.jobId,
					...object,
					token: query.token!,
					decision: "ALLOW",
					reasonCode: "PARTIAL",
					complete: false,
					evidence: {},
				}),
			),
		).rejects.toThrow("VIDEO_FULL_MODERATION_REQUIRED");
		await expect(scoped(() => finalizeVideoDelivery(item.jobId, object))).rejects.toThrow(
			"VIDEO_DELIVERY_PRECONDITION_FAILED",
		);
		await client.generationAttempt.updateMany({
			where: { jobId: item.jobId },
			data: { uncertainSubmission: true },
		});
		await expect(scoped(() => failVideoDelivery(item.jobId, "TIMEOUT"))).rejects.toThrow(
			"VIDEO_UNCERTAIN_RESERVATION_MUST_REMAIN",
		);
		expect(
			(await client.creditReservation.findUniqueOrThrow({ where: { jobId: item.jobId } })).status,
		).toBe("ACTIVE");
		await client.generationAttempt.updateMany({
			where: { jobId: item.jobId },
			data: { uncertainSubmission: false },
		});
		await scoped(() => failVideoDelivery(item.jobId, "TEST_CLEANUP"));
	});
	it("migrates prepayment capacity without double counting and commits only actual output bytes", async () => {
		const item = await fixture();
		const prepay = await client.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId: item.ownerId,
				referenceKey: `video-output:${item.jobId}`,
				bytes: 104857600n,
				expiresAt: new Date(0),
			},
		});
		// Accepted capacity must survive a later quota reduction and elapsed TTL.
		const claim = await scoped(() => claimVideoOutputStorage(item.jobId, 1n));
		expect(claim.maxBytes).toBe(104857600);
		expect(
			await client.storageUsageReservation.findMany({ where: { ownerId: item.ownerId } }),
		).toEqual([
			expect.objectContaining({
				id: prepay.id,
				referenceKey: `generation-output:${claim.asset.id}`,
				bytes: 104857600n,
				status: "ACTIVE",
			}),
		]);
		const output = {
			bytes: 1000,
			checksum: "a".repeat(64),
			etag: "etag",
			durationMillis: 5000,
			width: 1280,
			height: 720,
			audioTracks: 0,
			videoTracks: 1 as const,
		};
		await scoped(() =>
			completeVideoOutputStorage(item.jobId, claim.asset.id, claim.token!, output),
		);
		await scoped(() =>
			completeVideoOutputStorage(item.jobId, claim.asset.id, claim.token!, output),
		);
		expect(
			await client.storageUsageReservation.findUnique({ where: { id: prepay.id } }),
		).toMatchObject({ bytes: 1000n, status: "COMMITTED" });
		await scoped(() => failVideoDelivery(item.jobId, "REVIEW_REJECTED", true));
		// Physical object cleanup, not a logical rejection, releases stored bytes.
		expect(
			await client.storageUsageReservation.findUnique({ where: { id: prepay.id } }),
		).toMatchObject({ bytes: 1000n, status: "COMMITTED" });
	});
	it("historical paid jobs recover only when the full output budget is available", async () => {
		const item = await fixture();
		await expect(scoped(() => claimVideoOutputStorage(item.jobId, 104857599n))).rejects.toThrow(
			"VIDEO_STORAGE_QUOTA_EXCEEDED",
		);
		expect(
			await client.generationJobAsset.count({ where: { jobId: item.jobId, role: "OUTPUT" } }),
		).toBe(0);
		const claim = await scoped(() => claimVideoOutputStorage(item.jobId, 104857600n));
		expect(claim.maxBytes).toBe(104857600);
		expect(
			await client.storageUsageReservation.count({
				where: { ownerId: item.ownerId, status: "ACTIVE", bytes: 104857600n },
			}),
		).toBe(1);
		expect(await client.generationAttempt.count({ where: { jobId: item.jobId } })).toBe(1);
	});
	it("historical partial reservations require a full upgrade without dropping expired competing capacity", async () => {
		const item = await fixture();
		const claim = await scoped(() => claimVideoOutputStorage(item.jobId, 104857600n));
		await scoped(() => releaseVideoStorageLease(item.jobId, claim.asset.id, claim.token!));
		const own = await client.storageUsageReservation.update({
			where: { referenceKey: `generation-output:${claim.asset.id}` },
			data: { bytes: 10n, expiresAt: new Date(0) },
		});
		await client.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId: item.ownerId,
				referenceKey: `media-upload:${crypto.randomUUID()}`,
				bytes: 1n,
				expiresAt: new Date(0),
			},
		});
		await expect(scoped(() => claimVideoOutputStorage(item.jobId, 104857600n))).rejects.toThrow(
			"VIDEO_STORAGE_QUOTA_EXCEEDED",
		);
		expect(
			await client.storageUsageReservation.findUnique({ where: { id: own.id } }),
		).toMatchObject({ bytes: 10n });
		const retry = await scoped(() => claimVideoOutputStorage(item.jobId, 104857601n));
		expect(retry.asset.id).toBe(claim.asset.id);
		expect(
			await client.storageUsageReservation.findUnique({ where: { id: own.id } }),
		).toMatchObject({ bytes: 104857600n });
	});
	it("DB failure resume preserves one asset/key, quota reservation, attempt and immutable identity", async () => {
		const item = await fixture();
		const initial = await scoped(() => claimVideoOutputStorage(item.jobId, 200_000_000n));
		await scoped(() => releaseVideoStorageLease(item.jobId, initial.asset.id, initial.token!));
		const retry = await scoped(() => claimVideoOutputStorage(item.jobId, 200_000_000n));
		expect(retry.asset.objectKey).toBe(initial.asset.objectKey);
		expect(retry.asset.id).toBe(initial.asset.id);
		expect(await client.storageUsageReservation.count({ where: { ownerId: item.ownerId } })).toBe(
			1,
		);
		expect(await client.generationAttempt.count({ where: { jobId: item.jobId } })).toBe(1);
		await scoped(() => failVideoDelivery(item.jobId, "TEST_CLEANUP"));
	});
	it("deleted/expired evidence prevents owner playback", async () => {
		const item = await fixture();
		const object = await approved(item.jobId);
		await scoped(() => finalizeVideoDelivery(item.jobId, { ...object, checkedAt: new Date() }));
		await client.mediaAsset.update({
			where: { id: object.assetId },
			data: { deletedAt: new Date() },
		});
		expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).toBeNull();
		expect(VIDEO_V1_POLICY_VERSION).toBeTruthy();
		expect(VIDEO_V1_RULE_VERSION).toBeTruthy();
	});
	it("immutable approval remains valid on day two and expires with the advertised retention", async () => {
		const item = await fixture();
		const object = await approved(item.jobId);
		await scoped(() => finalizeVideoDelivery(item.jobId, { ...object, checkedAt: new Date() }));
		const asset = await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId));
		expect(asset).not.toBeNull();
		expect(asset!.deleteAfter).toEqual(asset!.verificationValidUntil);
		expect(hasVideoApproval(asset!, new Date(Date.now() + 2 * 24 * 3600_000))).toBe(true);
		expect(hasVideoApproval(asset!, new Date(Date.now() + 31 * 24 * 3600_000))).toBe(false);
	});
	it("a crash immediately after persisted rejection cannot strand or duplicate the release", async () => {
		const item = await fixture();
		const object = await stored(item.jobId);
		const submit = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await scoped(() => recordVideoReviewTask(object.assetId, submit.token!, crypto.randomUUID()));
		const query = await scoped(() => claimVideoOutputReview(item.jobId, 1800));
		await scoped(() =>
			recordVideoOutputReview({
				jobId: item.jobId,
				...object,
				token: query.token!,
				decision: "REJECT",
				reasonCode: "SEXUAL_CONTENT",
				complete: false,
				evidence: {},
			}),
		);
		// Simulate losing the workflow response here: do not call failVideoDelivery.
		expect(
			(await client.creditReservation.findUniqueOrThrow({ where: { jobId: item.jobId } })).status,
		).toBe("RELEASED");
		expect(await scoped(() => claimVideoOutputReview(item.jobId, 1800))).toMatchObject({
			status: "REJECTED",
			reasonCode: "SEXUAL_CONTENT",
		});
		await scoped(() => failVideoDelivery(item.jobId, "SEXUAL_CONTENT", true));
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: item.accountId, type: "RELEASE" },
			}),
		).toBe(1);
	});
	it("READ COMMITTED finalization shares the asset deletion lock and never resurrects deleted output", async () => {
		const item = await fixture();
		const object = await approved(item.jobId);
		const outcomes = await Promise.allSettled([
			scoped(() => finalizeVideoDelivery(item.jobId, { ...object, checkedAt: new Date() })),
			markMediaAssetDeletedTransaction({ assetId: object.assetId, ownerId: item.ownerId }, client),
		]);
		expect(outcomes[0]!.status).toBe("fulfilled");
		const asset = await client.mediaAsset.findUniqueOrThrow({ where: { id: object.assetId } });
		if (outcomes[1]!.status === "fulfilled") {
			expect(asset.status).toBe("DELETED");
			expect(asset.deletedAt).not.toBeNull();
			expect(await scoped(() => authorizeVideoPlayback(item.ownerId, item.jobId))).toBeNull();
		} else {
			expect(asset.status).toBe("READY");
			expect(asset.deletedAt).toBeNull();
		}
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: item.accountId, type: "SETTLE" },
			}),
		).toBe(1);
	});
});
