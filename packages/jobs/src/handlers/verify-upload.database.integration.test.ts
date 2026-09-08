import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
} from "@repo/ai";
import {
	claimGenerationDraftTransaction,
	createGenerationDraftTransaction,
	getOwnedMediaAssetReadState,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabaseVerifyUploadDependencies } from "../runtime";
import { verifyUpload } from "./verify-upload";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const MP4_HEADER = Buffer.from("00000018667479706d70343200000000", "hex");
let client: PrismaClient;

describe("claimed draft asset verification", () => {
	beforeAll(() => {
		assertSafeTestDatabaseUrl(TEST_DATABASE_URL);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it.each([
		["ALLOW", "READY", "APPROVED"],
		["REJECT", "QUARANTINED", "REJECTED"],
		["REVIEW", "QUARANTINED", "REVIEW"],
	] as const)(
		"carries a claimed draft through MEDIA_ASSET_VERIFY to %s moderation",
		async (decision, expectedAssetStatus, expectedModerationStatus) => {
			const suffix = crypto.randomUUID();
			const assetId = `asset_${suffix.replaceAll("-", "")}`;
			const objectKey = `drafts/${suffix}.png`;
			const tokenHash = suffix.replaceAll("-", "").padEnd(64, "0").slice(0, 64);
			const draft = await createGenerationDraftTransaction(
				{
					claimTokenHash: tokenHash,
					productKey: "image-nano-banana-2-lite",
					input: {
						kind: "image-to-image",
						prompt: "safe draft",
						skuKey: "nano-banana-2-lite-1k",
						aspectRatio: "auto",
					},
					expiresAt: new Date(Date.now() + 60_000),
					asset: {
						id: assetId,
						objectKey,
						mimeType: "image/png",
						byteSize: 16n,
						checksum: "e".repeat(64),
						finalizedAt: new Date(),
					},
				},
				client,
			);

			await claimGenerationDraftTransaction(
				{
					claimTokenHash: tokenHash,
					userId: `user-${suffix}`,
					allowedProductKeys: ["image-nano-banana-2-lite"],
				},
				client,
			);
			const event = await client.outboxEvent.findUniqueOrThrow({
				where: { dedupeKey: `media-asset-verify:${assetId}` },
			});
			expect(event).toMatchObject({
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateId: assetId,
				payload: { assetId },
			});

			const moderationEvidence = {
				requestId: "request_image_fixture",
				models: ["nudity-2.1", "weapon", "gore-2.0", "violence", "self-harm"],
				operations: 2,
				scores: { "nudity.erotica": decision === "ALLOW" ? 0.01 : 0.9 },
			};
			const safety = new TestMediaSafetyAdapter(decision);
			vi.spyOn(safety, "moderateImage").mockResolvedValue({
				decision,
				reasonCode: "FIXTURE_DECISION",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				evidence: moderationEvidence,
			});
			const dependencies = createDatabaseVerifyUploadDependencies(client, {
				headObject: async () => ({
					contentLength: 16,
					contentType: "image/png",
					etag: '"etag"',
					metadata: {},
				}),
				readMediaHeader: async () => PNG_HEADER,
				createSignedReadUrl: async () => "https://private.example/signed.png",
				safety,
				moderationProvider: "test",
			});
			await verifyUpload({ assetId }, dependencies);
			await verifyUpload({ assetId }, dependencies);

			const verifiedAsset = await client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
			expect(verifiedAsset).toMatchObject({
				status: expectedAssetStatus,
				ownerType: "USER",
				ownerId: `user-${suffix}`,
			});
			const evidence = await client.assetModerationResult.findFirstOrThrow({
				where: { assetId, provider: "test" },
				orderBy: { createdAt: "desc" },
			});
			expect(evidence).toMatchObject({
				status: expectedModerationStatus,
				assetChecksum: "e".repeat(64),
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				categories: { reasonCode: "FIXTURE_DECISION", scores: moderationEvidence.scores },
				rawEnvelope: { decision, evidence: moderationEvidence },
			});
			expect(JSON.stringify(evidence.rawEnvelope)).not.toMatch(/signed\.png|safe draft/);
			if (decision === "ALLOW") {
				expect(verifiedAsset.verificationValidUntil).toBeInstanceOf(Date);
				expect(evidence.validUntil?.getTime()).toBe(
					verifiedAsset.verificationValidUntil?.getTime(),
				);
				expect(evidence.validUntil!.getTime()).toBeGreaterThan(Date.now());
				await expect(
					getOwnedMediaAssetReadState(
						{
							assetId,
							ownerId: `user-${suffix}`,
							verification: {
								provider: "test",
								ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
								policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
								now: new Date(Date.now() + 365 * 24 * 60 * 60_000),
							},
						},
						client,
					),
				).resolves.toMatchObject({ readable: true });
			} else {
				expect(verifiedAsset.verificationValidUntil).toBeNull();
				expect(evidence.validUntil).toBeNull();
			}
			await expect(client.assetModerationResult.count({ where: { assetId } })).resolves.toBe(1);
			expect(draft.id).toBeTruthy();
		},
	);

	it.each([
		["ALLOW", "READY", "APPROVED"],
		["REJECT", "QUARANTINED", "REJECTED"],
		["REVIEW", "QUARANTINED", "REVIEW"],
	] as const)(
		"gates generated outputs on %s and retains output evidence",
		async (decision, assetStatus, moderationStatus) => {
			const suffix = crypto.randomUUID();
			const asset = await client.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId: `output-owner-${suffix}`,
					kind: "OUTPUT",
					status: "VERIFYING",
					objectKey: `outputs/${suffix}.png`,
					mimeType: "image/png",
					byteSize: 16n,
					checksum: "d".repeat(64),
					finalizedAt: new Date(),
				},
			});
			const safety = new TestMediaSafetyAdapter(decision);
			const evidence = {
				requestId: "request_output_fixture",
				models: ["nudity-2.1"],
				operations: 1,
				scores: { "nudity.erotica": decision === "ALLOW" ? 0.01 : 0.9 },
			};
			vi.spyOn(safety, "moderateImage").mockResolvedValue({
				decision,
				reasonCode: "FIXTURE_DECISION",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				evidence,
			});
			const dependencies = createDatabaseVerifyUploadDependencies(client, {
				safety,
				moderationProvider: "test",
				headObject: async () => ({
					contentLength: 16,
					contentType: "image/png",
					etag: '"etag"',
					metadata: {},
				}),
				readMediaHeader: async () => PNG_HEADER,
				createSignedReadUrl: async () => "https://private.example/signed-output.png",
			});
			await verifyUpload({ assetId: asset.id }, dependencies);
			await expect(
				client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
			).resolves.toMatchObject({ status: assetStatus });
			await expect(
				getOwnedMediaAssetReadState(
					{
						assetId: asset.id,
						ownerId: `output-owner-${suffix}`,
						verification: {
							provider: "test",
							ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
							policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
							now: new Date(Date.now() + 365 * 24 * 60 * 60_000),
						},
					},
					client,
				),
			).resolves.toMatchObject({ readable: decision === "ALLOW" });
			await expect(
				client.assetModerationResult.findFirstOrThrow({ where: { assetId: asset.id } }),
			).resolves.toMatchObject({
				evidenceKind: "OUTPUT",
				status: moderationStatus,
				assetChecksum: "d".repeat(64),
				rawEnvelope: { decision, evidence },
			});
		},
	);

	it("re-verifies only the explicitly authorized legacy quarantine and persists a fresh fingerprint", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `legacy_asset_${suffix.replaceAll("-", "")}`;
		const ownerId = `legacy-owner-${suffix}`;
		let inspections = 0;
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: '"fresh-etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_HEADER,
			inspectPrivateMediaObject: async () => {
				inspections += 1;
				return {
					bytes: 16,
					sha256: "f".repeat(64),
					etag: '"fresh-etag"',
					versionId: "fresh-version",
				};
			},
			createSignedReadUrl: async () => "https://private.example/legacy.png",
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "legacy-test",
		});
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "QUARANTINED",
				objectKey: `users/${ownerId}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED",
			},
		});

		await verifyUpload({ assetId }, dependencies);
		expect(inspections).toBe(0);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "QUARANTINED",
			checksum: null,
		});

		await verifyUpload({ assetId, allowQuarantinedReverification: true }, dependencies);
		expect(inspections).toBe(1);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "READY",
			checksum: "f".repeat(64),
			storageEtag: '"fresh-etag"',
			storageVersionId: "fresh-version",
			finalizedAt: expect.any(Date),
		});
		await expect(
			client.auditLog.count({
				where: {
					targetType: "MEDIA_ASSET",
					targetId: assetId,
					action: "MEDIA_ASSET_LEGACY_REVERIFICATION_STARTED",
				},
			}),
		).resolves.toBe(1);

		const rejectedAssetId = `rejected_asset_${suffix.replaceAll("-", "")}`;
		await client.mediaAsset.create({
			data: {
				id: rejectedAssetId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "QUARANTINED",
				objectKey: `users/${ownerId}/assets/${rejectedAssetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				finalizedAt: new Date(),
			},
		});
		await verifyUpload(
			{ assetId: rejectedAssetId, allowQuarantinedReverification: true },
			dependencies,
		);
		expect(inspections).toBe(1);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: rejectedAssetId } }),
		).resolves.toMatchObject({ status: "QUARANTINED" });
	});

	it("retries the full legacy inspection after a transient inspection failure", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `legacy_retry_${suffix.replaceAll("-", "")}`;
		const ownerId = `legacy-retry-owner-${suffix}`;
		let inspections = 0;
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: '"fresh-etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_HEADER,
			inspectPrivateMediaObject: async () => {
				inspections += 1;
				if (inspections === 1) throw new Error("transient object-store failure");
				return {
					bytes: 16,
					sha256: "a".repeat(64),
					etag: '"fresh-etag"',
					versionId: "fresh-version",
				};
			},
			createSignedReadUrl: async () => "https://private.example/legacy-retry.png",
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "legacy-retry-test",
		});
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "QUARANTINED",
				objectKey: `users/${ownerId}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED",
			},
		});

		await verifyUpload({ assetId, allowQuarantinedReverification: true }, dependencies);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "VERIFYING",
			checksum: null,
			finalizedAt: null,
			verificationAttemptCount: 1,
			verificationLastErrorCode: "VERIFICATION_TRANSIENT",
		});
		await expect(
			client.assetModerationResult.findFirstOrThrow({
				where: { assetId, status: "ERROR" },
			}),
		).resolves.toMatchObject({ assetChecksum: null, reasonCode: "VERIFICATION_TRANSIENT" });
		await client.mediaAsset.update({
			where: { id: assetId },
			data: { verificationNextAttemptAt: new Date(0) },
		});
		await verifyUpload({ assetId }, dependencies);
		expect(inspections).toBe(2);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "READY",
			checksum: "a".repeat(64),
			storageEtag: '"fresh-etag"',
			storageVersionId: "fresh-version",
			finalizedAt: expect.any(Date),
		});
	});

	it("moves exhausted verification attempts out of VERIFYING without approving the asset", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `verification_exhausted_${suffix.replaceAll("-", "")}`;
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `verification-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/verification-owner-${suffix}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "b".repeat(64),
				finalizedAt: new Date(),
			},
		});
		class UnavailableSafetyAdapter extends TestMediaSafetyAdapter {
			override async moderateImage(input: { assetUrl: string; ruleVersion: string }) {
				return {
					decision: "ERROR" as const,
					reasonCode: "MODERATION_UNAVAILABLE",
					ruleVersion: input.ruleVersion,
				};
			}
		}
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: '"etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_HEADER,
			createSignedReadUrl: async () => "https://private.example/exhausted.png",
			safety: new UnavailableSafetyAdapter("ERROR"),
			moderationProvider: "test",
		});

		for (let attempt = 0; attempt < 4; attempt += 1) {
			await verifyUpload({ assetId }, dependencies).catch(() => undefined);
			await client.mediaAsset.updateMany({
				where: { id: assetId, status: "VERIFYING" },
				data: { verificationNextAttemptAt: new Date(0), verificationLeasedUntil: new Date(0) },
			});
		}

		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationAttemptCount: 4,
			verificationExhaustedAt: expect.any(Date),
			verificationLastErrorCode: "MODERATION_UNAVAILABLE",
		});
		await expect(client.assetModerationResult.count({ where: { assetId } })).resolves.toBe(4);
	});

	it("does not spend the transient failure budget on normal video processing polls", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `verification_video_pending_${suffix.replaceAll("-", "")}`;
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `verification-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/verification-owner-${suffix}/assets/${assetId}/original.mp4`,
				mimeType: "video/mp4",
				byteSize: 16n,
				checksum: "d".repeat(64),
				finalizedAt: new Date(),
			},
		});
		class ProcessingVideoSafetyAdapter extends TestMediaSafetyAdapter {
			submissions = 0;
			retrievals = 0;

			override async submitVideo(input: {
				assetUrl: string;
				ruleVersion: string;
				idempotencyKey: string;
			}) {
				this.submissions += 1;
				return {
					moderationTaskId: `video-task-${suffix}`,
					status: "QUEUED" as const,
					ruleVersion: input.ruleVersion,
					idempotency: {
						key: input.idempotencyKey,
						providerSupported: true,
						replayed: false,
					},
				};
			}

			override async retrieveVideo(input: { moderationTaskId: string; ruleVersion: string }) {
				this.retrievals += 1;
				return this.retrievals <= 5
					? {
							decision: "REVIEW" as const,
							reasonCode: "VIDEO_PROCESSING",
							ruleVersion: input.ruleVersion,
						}
					: {
							decision: "ALLOW" as const,
							reasonCode: "VIDEO_APPROVED",
							ruleVersion: input.ruleVersion,
						};
			}
		}
		const safety = new ProcessingVideoSafetyAdapter("ALLOW");
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "video/mp4",
				etag: '"etag"',
				metadata: {},
			}),
			readMediaHeader: async () => MP4_HEADER,
			createSignedReadUrl: async () => "https://private.example/processing.mp4",
			safety,
			moderationProvider: "test",
		});

		for (let poll = 0; poll < 6; poll += 1) {
			await verifyUpload({ assetId }, dependencies);
			await client.mediaAsset.updateMany({
				where: { id: assetId, status: "VERIFYING" },
				data: { verificationNextAttemptAt: new Date(0), verificationLeasedUntil: new Date(0) },
			});
		}

		expect(safety.submissions).toBe(1);
		expect(safety.retrievals).toBe(6);
		await expect(
			client.assetModerationResult.count({ where: { assetId, status: "ERROR" } }),
		).resolves.toBe(0);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "READY",
			verificationAttemptCount: 6,
		});
		await expect(client.assetModerationResult.count({ where: { assetId } })).resolves.toBe(6);
	});

	it("does not resubmit a video after the provider accepted it but task binding did not commit", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `verification_video_uncertain_${suffix.replaceAll("-", "")}`;
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `verification-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/verification-owner-${suffix}/assets/${assetId}/original.mp4`,
				mimeType: "video/mp4",
				byteSize: 16n,
				checksum: "e".repeat(64),
				finalizedAt: new Date(),
			},
		});
		class AcceptedVideoSafetyAdapter extends TestMediaSafetyAdapter {
			submissions = 0;

			override async submitVideo(input: {
				assetUrl: string;
				ruleVersion: string;
				idempotencyKey: string;
			}) {
				this.submissions += 1;
				return {
					moderationTaskId: `accepted-video-task-${suffix}`,
					status: "QUEUED" as const,
					ruleVersion: input.ruleVersion,
					idempotency: {
						key: input.idempotencyKey,
						providerSupported: false,
						replayed: false,
					},
				};
			}
		}
		const safety = new AcceptedVideoSafetyAdapter("ALLOW");
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "video/mp4",
				etag: '"etag"',
				metadata: {},
			}),
			readMediaHeader: async () => MP4_HEADER,
			createSignedReadUrl: async () => "https://private.example/uncertain.mp4",
			safety,
			moderationProvider: "test",
			afterVideoSubmission: async () => {
				throw new Error("simulated crash before task binding");
			},
		});

		await verifyUpload({ assetId }, dependencies);
		await verifyUpload({ assetId }, dependencies);

		expect(safety.submissions).toBe(1);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationProviderTaskId: null,
			verificationSubmissionToken: expect.any(String),
			verificationSubmissionUncertain: true,
			verificationExhaustedAt: expect.any(Date),
			verificationLastErrorCode: "VIDEO_SUBMISSION_UNCERTAIN_REQUIRES_REVIEW",
		});
		await expect(
			client.assetModerationResult.findFirstOrThrow({ where: { assetId } }),
		).resolves.toMatchObject({
			status: "ERROR",
			reasonCode: "VIDEO_SUBMISSION_UNCERTAIN_REQUIRES_REVIEW",
		});
	});

	it("does not fail an in-flight video submission when another worker observes its uncertainty fence", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `verification_video_concurrent_${suffix.replaceAll("-", "")}`;
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `verification-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/verification-owner-${suffix}/assets/${assetId}/original.mp4`,
				mimeType: "video/mp4",
				byteSize: 16n,
				checksum: "7".repeat(64),
				finalizedAt: new Date(),
			},
		});
		let submissionStarted!: () => void;
		let releaseSubmission!: () => void;
		const started = new Promise<void>((resolve) => {
			submissionStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseSubmission = resolve;
		});
		class SlowAcceptedVideoSafetyAdapter extends TestMediaSafetyAdapter {
			submissions = 0;

			override async submitVideo(input: {
				assetUrl: string;
				ruleVersion: string;
				idempotencyKey: string;
			}) {
				this.submissions += 1;
				submissionStarted();
				await release;
				return {
					moderationTaskId: `concurrent-video-task-${suffix}`,
					status: "QUEUED" as const,
					ruleVersion: input.ruleVersion,
					idempotency: {
						key: input.idempotencyKey,
						providerSupported: true,
						replayed: false,
					},
				};
			}
		}
		const safety = new SlowAcceptedVideoSafetyAdapter("ALLOW");
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "video/mp4",
				etag: '"etag"',
				metadata: {},
			}),
			readMediaHeader: async () => MP4_HEADER,
			createSignedReadUrl: async () => "https://private.example/concurrent-video.mp4",
			safety,
			moderationProvider: "test",
		});

		const first = verifyUpload({ assetId }, dependencies);
		await started;
		await verifyUpload({ assetId }, dependencies);
		releaseSubmission();
		await first;

		expect(safety.submissions).toBe(1);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "READY",
			verificationSubmissionUncertain: false,
			verificationProviderTaskId: `concurrent-video-task-${suffix}`,
		});
	});

	it.each(["media-policy-2026-09-08.1", "media-policy-2026-09-08.2"])(
		"reuses expired matching image approval from %s without an API call",
		async (sourcePolicyVersion) => {
			const suffix = crypto.randomUUID();
			const assetId = `verification_stale_ready_${suffix.replaceAll("-", "")}`;
			const checksum = "9".repeat(64);
			const [databaseClock] = await client.$queryRaw<Array<{ now: Date }>>`
			SELECT CURRENT_TIMESTAMP AS "now"`;
			if (!databaseClock) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
			const validUntil = new Date(databaseClock.now.getTime() + 750);
			await client.mediaAsset.create({
				data: {
					id: assetId,
					ownerType: "USER",
					ownerId: `verification-owner-${suffix}`,
					kind: "INPUT",
					status: "VERIFYING",
					objectKey: `users/verification-owner-${suffix}/assets/${assetId}/original.png`,
					mimeType: "image/png",
					byteSize: 16n,
					checksum,
					finalizedAt: new Date(),
					verificationGeneration: 1,
					verificationAttemptCount: 1,
					verificationProvider: "test",
					verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					verificationPolicyVersion: sourcePolicyVersion,
					verificationValidUntil: validUntil,
				},
			});
			const originalEvidence = await client.assetModerationResult.create({
				data: {
					assetId,
					assetChecksum: checksum,
					verificationGeneration: 1,
					attemptNumber: 1,
					evidenceKind: "INPUT",
					provider: "test",
					ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					policyVersion: sourcePolicyVersion,
					status: "APPROVED",
					reasonCode: "TEST_ALLOW",
					categories: {},
					rawEnvelope: { decision: "ALLOW" },
					validUntil,
				},
			});
			await client.mediaAsset.update({ where: { id: assetId }, data: { status: "READY" } });
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(validUntil.getTime() + 25));
			try {
				const safety = new TestMediaSafetyAdapter("ALLOW");
				const moderateImage = vi.spyOn(safety, "moderateImage");
				const dependencies = createDatabaseVerifyUploadDependencies(client, {
					headObject: async () => ({
						contentLength: 16,
						contentType: "image/png",
						etag: '"etag"',
						metadata: {},
					}),
					readMediaHeader: async () => PNG_HEADER,
					createSignedReadUrl: async () => "https://private.example/stale.png",
					safety,
					moderationProvider: "test",
				});
				await Promise.all([
					verifyUpload({ assetId }, dependencies),
					verifyUpload({ assetId }, dependencies),
				]);
				expect(moderateImage).not.toHaveBeenCalled();

				await expect(
					client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
				).resolves.toMatchObject({
					status: "READY",
					verificationGeneration: 2,
					verificationAttemptCount: 1,
					verificationValidUntil: expect.any(Date),
					verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				});
				await expect(client.assetModerationResult.count({ where: { assetId } })).resolves.toBe(2);
				await expect(
					client.assetModerationResult.findFirstOrThrow({
						where: { assetId, verificationGeneration: 2 },
					}),
				).resolves.toMatchObject({
					status: "APPROVED",
					rawEnvelope: { reusedEvidenceId: originalEvidence.id },
				});
				await expect(
					client.assetModerationResult.findUniqueOrThrow({ where: { id: originalEvidence.id } }),
				).resolves.toMatchObject({ validUntil, policyVersion: sourcePolicyVersion });
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("leases verification so concurrent workers call moderation only once", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `verification_concurrent_${suffix.replaceAll("-", "")}`;
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `verification-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/verification-owner-${suffix}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "c".repeat(64),
				finalizedAt: new Date(),
			},
		});
		class CountingSafetyAdapter extends TestMediaSafetyAdapter {
			calls = 0;

			override async moderateImage(input: { assetUrl: string; ruleVersion: string }) {
				this.calls += 1;
				await new Promise((resolve) => setTimeout(resolve, 25));
				return super.moderateImage(input);
			}
		}
		const safety = new CountingSafetyAdapter("ALLOW");
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: '"etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_HEADER,
			createSignedReadUrl: async () => "https://private.example/concurrent.png",
			safety,
			moderationProvider: "test",
		});

		await Promise.all([
			verifyUpload({ assetId }, dependencies),
			verifyUpload({ assetId }, dependencies),
		]);

		expect(safety.calls).toBe(1);
		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "READY",
			verificationAttemptCount: 1,
		});
		await expect(client.assetModerationResult.count({ where: { assetId } })).resolves.toBe(1);
	});

	it("does not authorize READY after the verification lease expires", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `verification_expired_${suffix.replaceAll("-", "")}`;
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId: `verification-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/verification-owner-${suffix}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: "f".repeat(64),
				finalizedAt: new Date(),
			},
		});
		let moderationStarted!: () => void;
		let releaseModeration!: () => void;
		const started = new Promise<void>((resolve) => {
			moderationStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseModeration = resolve;
		});
		class SlowSafetyAdapter extends TestMediaSafetyAdapter {
			override async moderateImage(input: { assetUrl: string; ruleVersion: string }) {
				moderationStarted();
				await release;
				return super.moderateImage(input);
			}
		}
		const dependencies = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: 16,
				contentType: "image/png",
				etag: '"etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_HEADER,
			createSignedReadUrl: async () => "https://private.example/expired.png",
			safety: new SlowSafetyAdapter("ALLOW"),
			moderationProvider: "test",
		});

		const verification = verifyUpload({ assetId }, dependencies);
		await started;
		await client.mediaAsset.update({
			where: { id: assetId },
			data: { verificationLeasedUntil: new Date(0) },
		});
		releaseModeration();
		await verification;

		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "VERIFYING",
		});
		await expect(client.assetModerationResult.count({ where: { assetId } })).resolves.toBe(0);
	});
});

function assertSafeTestDatabaseUrl(value: string | undefined): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	const safeDatabase =
		parsed.pathname === "/ai_media_foundation_test" ||
		/^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname);
	if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || !safeDatabase) {
		throw new Error(
			"TEST_DATABASE_URL must target 127.0.0.1:55432/ai_media_foundation_test or a dedicated ezpic_*_test database",
		);
	}
}
