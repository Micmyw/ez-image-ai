import { PrismaPg } from "@prisma/adapter-pg";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
	type ProviderOutput,
} from "@repo/ai";
import {
	claimGenerationOutputTransferTransaction,
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	failGenerationOutputTransferTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import {
	MediaValidationError,
	promoteStagedObject,
	putPrivateMediaObject,
	RemoteMediaPolicyError,
	streamRemoteObjectToStorage,
} from "@repo/storage";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const globalStorage = vi.hoisted(() => ({
	putPrivateMediaObject: vi.fn(async () => {
		throw new Error("GLOBAL_STORAGE_USED");
	}),
	streamRemoteObjectToStorage: vi.fn(async () => {
		throw new Error("GLOBAL_STORAGE_USED");
	}),
	promoteStagedObject: vi.fn(async () => {
		throw new Error("GLOBAL_STORAGE_USED");
	}),
}));

vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	...globalStorage,
}));

import {
	createDatabaseDispatchStore,
	createDatabaseFinalizationStore,
	createDatabaseVerifyUploadDependencies,
	createFinalizationDependencies,
} from "../runtime";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PNG_BODY = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
const PNG_CHECKSUM = "d".repeat(64);
let client: PrismaClient;

describe("generation output transfer runtime", () => {
	beforeAll(() => {
		assertSafeTestDatabaseUrl(TEST_DATABASE_URL);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("lets one actor write staging and fences a concurrent duplicate before storage", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/output.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected finalization claim");
		let releaseStorage!: () => void;
		let storageReached!: () => void;
		const reached = new Promise<void>((resolve) => {
			storageReached = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseStorage = resolve;
		});
		const stream = vi.fn(async (_input: Parameters<typeof streamRemoteObjectToStorage>[0]) => {
			storageReached();
			await released;
			return { bytes: PNG_BODY.byteLength, sha256: PNG_CHECKSUM };
		});
		const put = vi.fn(async (_input: Parameters<typeof putPrivateMediaObject>[0]) => ({
			bytes: PNG_BODY.byteLength,
			sha256: PNG_CHECKSUM,
		}));
		const promote = vi.fn(async (input: Parameters<typeof promoteStagedObject>[0]) => {
			await input.promotion?.onMultipartUploadCreated?.({ uploadId: "promotion-runtime-1" });
			return {
				bytes: PNG_BODY.byteLength,
				sha256: PNG_CHECKSUM,
				etag: '"runtime-final-etag"',
				versionId: "runtime-final-version",
			};
		});
		const productionVerification = createDatabaseVerifyUploadDependencies(client, {
			headObject: async () => ({
				contentLength: PNG_BODY.byteLength,
				contentType: "image/png",
				etag: '"runtime-final-etag"',
				metadata: {},
			}),
			readMediaHeader: async () => PNG_BODY,
			inspectPrivateMediaObject: async () => ({
				bytes: PNG_BODY.byteLength,
				sha256: PNG_CHECKSUM,
				etag: '"runtime-final-etag"',
				versionId: "runtime-final-version",
			}),
			createSignedReadUrl: async () => "https://private.example/runtime-output.png",
			safety: new TestMediaSafetyAdapter("ALLOW"),
			moderationProvider: "test",
		});
		const verify = vi.fn((assetId: string) => productionVerification.verify(assetId));
		const dependencies = createFinalizationDependencies(process.env, {
			database: client,
			verification: { verify },
			storage: {
				putPrivateMediaObject: put,
				streamRemoteObjectToStorage: stream,
				promoteStagedObject: promote,
			},
		});

		const first = dependencies.persistCandidate(claim, claim.candidates[0]!);
		await expect(
			Promise.race([
				reached.then(() => "reached" as const),
				first.then(
					() => "finished" as const,
					() => "failed" as const,
				),
			]),
		).resolves.toBe("reached");
		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toMatchObject({
			code: "OUTPUT_TRANSFER_IN_PROGRESS",
			stage: "TRANSFER",
			retryable: true,
		});
		expect(stream).toHaveBeenCalledTimes(1);
		expect(put).not.toHaveBeenCalled();
		expect(promote).not.toHaveBeenCalled();

		releaseStorage();
		await expect(first).resolves.toMatchObject({ approved: true });
		expect(stream).toHaveBeenCalledTimes(1);
		expect(promote).toHaveBeenCalledTimes(1);
		expect(verify).toHaveBeenCalledTimes(1);
		const binding = await client.generationJobAsset.findFirstOrThrow({
			where: { jobId: seeded.jobId, role: "OUTPUT" },
			include: { asset: true },
		});
		expect(binding.assetId).toMatch(/^asset_[A-Za-z0-9_-]{32}$/u);
		expect(binding.assetChecksum).toBe(PNG_CHECKSUM);
		expect(binding.asset).toMatchObject({
			status: "READY",
			checksum: PNG_CHECKSUM,
			storageEtag: '"runtime-final-etag"',
			storageVersionId: "runtime-final-version",
			outputTransferToken: null,
			outputTransferLeaseExpiresAt: null,
			outputStagingObjectKey: null,
			outputPromotionMultipartUploadId: null,
		});
	});

	it("terminalizes a claimed output when deterministic remote validation fails", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/not-an-image.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected finalization claim");
		const validationError = new MediaValidationError(
			"OUTPUT_MEDIA_TYPE_MISMATCH",
			"Provider bytes do not match image/png",
		);
		const stream = vi.fn(async (_input: Parameters<typeof streamRemoteObjectToStorage>[0]) => {
			throw validationError;
		});
		const promote = vi.fn(async (_input: Parameters<typeof promoteStagedObject>[0]) =>
			Promise.reject(new Error("promotion must not run")),
		);
		const verify = vi.fn(async (_assetId: string) => undefined);
		const dependencies = createFinalizationDependencies(process.env, {
			database: client,
			verification: { verify },
			storage: { streamRemoteObjectToStorage: stream, promoteStagedObject: promote },
		});

		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toBe(
			validationError,
		);
		expect(promote).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		const binding = await client.generationJobAsset.findFirstOrThrow({
			where: { jobId: seeded.jobId, role: "OUTPUT" },
			include: { asset: true },
		});
		expect(binding.assetChecksum).toBe(`pending-output:${binding.assetId}`);
		expect(binding.asset).toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationLastErrorCode: "OUTPUT_MEDIA_TYPE_MISMATCH",
			verificationExhaustedAt: expect.any(Date),
			outputTransferToken: null,
			outputTransferLeaseExpiresAt: null,
			outputStagingObjectKey: null,
			outputPromotionMultipartUploadId: null,
		});
	});

	it("terminalizes a deterministic remote URL policy rejection without promotion", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://untrusted.example/output.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected finalization claim");
		const policyError = new RemoteMediaPolicyError(
			"OUTPUT_REMOTE_URL_HOST_NOT_ALLOWED",
			"Remote URL host is not allowed",
		);
		const stream = vi.fn(async (_input: Parameters<typeof streamRemoteObjectToStorage>[0]) => {
			throw policyError;
		});
		const promote = vi.fn(async (_input: Parameters<typeof promoteStagedObject>[0]) =>
			Promise.reject(new Error("promotion must not run")),
		);
		const dependencies = createFinalizationDependencies(process.env, {
			database: client,
			verification: { verify: vi.fn(async () => undefined) },
			storage: { streamRemoteObjectToStorage: stream, promoteStagedObject: promote },
		});

		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toBe(
			policyError,
		);
		expect(promote).not.toHaveBeenCalled();
		const binding = await client.generationJobAsset.findFirstOrThrow({
			where: { jobId: seeded.jobId, role: "OUTPUT" },
			include: { asset: true },
		});
		expect(binding.asset).toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationLastErrorCode: "OUTPUT_REMOTE_URL_HOST_NOT_ALLOWED",
			outputTransferToken: null,
		});
	});

	it("rejects aggregate output quota before promotion and queues fenced physical cleanup", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/quota.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		await client.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId: seeded.ownerId,
				bytes: 90n,
				status: "COMMITTED",
				referenceKey: `quota-existing:${crypto.randomUUID()}`,
				expiresAt: new Date(),
			},
		});
		const claim = await createDatabaseFinalizationStore(client).claimFinalization({
			jobId: seeded.jobId,
			version: seeded.version,
		});
		if (!claim) throw new Error("Expected finalization claim");
		const stream = vi.fn(async (_input: Parameters<typeof streamRemoteObjectToStorage>[0]) => ({
			bytes: PNG_BODY.byteLength,
			sha256: PNG_CHECKSUM,
		}));
		const promote = vi.fn(async (_input: Parameters<typeof promoteStagedObject>[0]) => ({
			bytes: PNG_BODY.byteLength,
			sha256: PNG_CHECKSUM,
			etag: '"quota-etag"',
			versionId: "quota-version",
		}));
		const dependencies = createFinalizationDependencies(
			{ ...process.env, MEDIA_MAX_STORAGE_BYTES: "100" },
			{
				database: client,
				verification: { verify: vi.fn(async () => undefined) },
				storage: { streamRemoteObjectToStorage: stream, promoteStagedObject: promote },
			},
		);

		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toMatchObject({
			code: "STORAGE_QUOTA_EXCEEDED",
			stage: "TRANSFER",
			retryable: false,
		});
		expect(stream).toHaveBeenCalledOnce();
		expect(promote).not.toHaveBeenCalled();
		const binding = await client.generationJobAsset.findFirstOrThrow({
			where: { jobId: seeded.jobId, role: "OUTPUT" },
			include: { asset: true },
		});
		expect(binding.asset).toMatchObject({
			status: "VERIFICATION_FAILED",
			verificationLastErrorCode: "STORAGE_QUOTA_EXCEEDED",
			outputTransferToken: null,
		});
		await expect(
			client.storageUsageReservation.findUnique({
				where: { referenceKey: `generation-output:${binding.assetId}` },
			}),
		).resolves.toBeNull();
		await expect(
			client.outboxEvent.findFirst({
				where: {
					aggregateId: binding.assetId,
					eventType: "MEDIA_OBJECT_DELETE",
				},
			}),
		).resolves.toMatchObject({
			payload: expect.objectContaining({
				objectKey: binding.asset.objectKey,
				storageReservationReferenceKey: `generation-output:${binding.assetId}`,
			}),
		});
	});

	it("records a checksumless rejected output and queues settlement after the full scan", async () => {
		const seeded = await seedFinalizingJob([
			{
				kind: "remote-url",
				url: "https://replicate.delivery/rejected.png",
				trust: "untrusted-transfer-candidate",
			},
		]);
		const store = createDatabaseFinalizationStore(client);
		const claim = await store.claimFinalization({ jobId: seeded.jobId, version: seeded.version });
		if (!claim) throw new Error("Expected finalization claim");
		const assetId = `asset_${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`;
		const objectKey = `users/${claim.ownerId}/assets/${assetId}/original.png`;
		const transfer = await claimGenerationOutputTransferTransaction(
			{
				jobId: claim.jobId,
				ownerId: claim.ownerId,
				assetId,
				objectKey,
				mimeType: "image/png",
				sourceUrl: `provider-output:${claim.candidates[0]!.key}`,
				createStagingObjectKey: (token) => `users/${claim.ownerId}/staging/${assetId}/${token}.png`,
			},
			client,
		);
		if (transfer.outcome !== "CLAIMED") throw new Error("Expected output transfer claim");
		await failGenerationOutputTransferTransaction(
			{
				assetId,
				ownerId: claim.ownerId,
				transferToken: transfer.transferToken,
				errorCode: "OUTPUT_MEDIA_TYPE_MISMATCH",
			},
			client,
		);

		await expect(
			store.recordFinalization(
				claim,
				[
					{
						assetId,
						approved: false,
						candidateKey: claim.candidates[0]!.key,
					},
				],
				{ stage: "TRANSFER", code: "OUTPUT_MEDIA_TYPE_MISMATCH", retryable: false },
			),
		).resolves.toBeUndefined();
		await expect(
			client.generationJobAsset.findUniqueOrThrow({
				where: { jobId_assetId_role: { jobId: claim.jobId, assetId, role: "OUTPUT" } },
			}),
		).resolves.toMatchObject({ assetChecksum: `pending-output:${assetId}` });
		await expect(
			client.outboxEvent.count({
				where: {
					aggregateId: claim.jobId,
					eventType: "GENERATION_SETTLE",
					dedupeKey: `generation-settle:${claim.jobId}`,
				},
			}),
		).resolves.toBe(1);
	});
});

async function seedFinalizingJob(outputs: ProviderOutput[]) {
	const suffix = crypto.randomUUID();
	const ownerId = `output-transfer-runtime-${suffix}`;
	const checksum = "a".repeat(64);
	const verificationValidUntil = new Date(Date.now() + 60_000);
	const inputAsset = await client.mediaAsset.create({
		data: {
			id: `asset_${suffix}`,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			objectKey: `users/${ownerId}/assets/${suffix}/original.png`,
			mimeType: "image/png",
			byteSize: 16n,
			checksum,
			finalizedAt: new Date(),
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			verificationValidUntil,
		},
	});
	await client.assetModerationResult.create({
		data: {
			assetId: inputAsset.id,
			assetChecksum: checksum,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: "test",
			ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			status: "APPROVED",
			reasonCode: "TEST_ALLOW",
			categories: {},
			rawEnvelope: { decision: "ALLOW" },
			validUntil: verificationValidUntil,
		},
	});
	await client.mediaAsset.update({ where: { id: inputAsset.id }, data: { status: "READY" } });
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `output-transfer-grant:${suffix}` },
		client,
	);
	const quoteInput = {
		ownerType: "USER",
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-quality",
		catalogVersion: "2026-08-13.1",
		pricingVersion: "2026-08-13.1",
		credits: 10n,
		costMicros: 8_000n,
		inputSnapshot: {
			kind: "image-to-image",
			prompt: "output transfer test",
			sourceAssetId: inputAsset.id,
		},
		pricingSnapshot: { credits: "10" },
		expiresAt: new Date(Date.now() + 60_000),
	} as const;
	const quote = await createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: "TEST_OUTPUT_TRANSFER_RUNTIME_V1",
				reasonCode: "TEST_ALLOW_OUTPUT_TRANSFER",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		client,
	);
	const created = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `output-transfer-job:${suffix}`,
			inputAssetIds: [inputAsset.id],
			expectedModerationRuleVersion: "TEST_OUTPUT_TRANSFER_RUNTIME_V1",
			expectedAssetModerationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			expectedAssetModerationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		},
		client,
	);
	const dispatchStore = createDatabaseDispatchStore(client, {
		createSignedReadUrl: async () => "https://private.example/output-transfer-input.png",
	});
	const dispatch = await dispatchStore.claimDispatch({ jobId: created.job.id, version: 0 });
	if (!dispatch) throw new Error("Expected dispatch claim");
	await dispatchStore.recordSynchronousCompletion(
		dispatch.attemptId,
		{
			outcome: "accepted",
			providerTaskId: dispatch.attemptId,
			status: "SUCCEEDED",
			idempotency: { key: dispatch.attemptId, providerSupported: false, replayed: false },
			reconciliation: { submissionToken: dispatch.attemptId },
		},
		{
			outputs,
			progress: 100,
			providerCostMicros: 8_000,
			failure: null,
			retryable: false,
			providerCharged: true,
		},
	);
	const job = await client.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
	return { jobId: job.id, ownerId, version: job.version };
}

function assertSafeTestDatabaseUrl(value: string | undefined): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	const databaseName = parsed.pathname.slice(1).toLowerCase();
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		parsed.port !== "55432" ||
		!/(^|[_-])(test|testing)([_-]|$)/u.test(databaseName) ||
		["postgres", "template0", "template1"].includes(databaseName)
	) {
		throw new Error("TEST_DATABASE_URL must target a local test database on port 55432");
	}
}
