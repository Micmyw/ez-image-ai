import { Readable } from "node:stream";

import { TestMediaSafetyAdapter } from "@repo/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ claim: vi.fn(), complete: vi.fn(), reserve: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", async () => ({
	...(await vi.importActual<typeof import("@repo/database")>("@repo/database")),
	claimGenerationOutputTransferTransaction: boundary.claim,
	completeGenerationOutputTransferTransaction: boundary.complete,
	reserveGenerationOutputStorageTransaction: boundary.reserve,
}));

import { GenerationTransferRequiresHeavyError, type FinalizationClaim } from "../contracts";
import { createDatabaseFinalizationStore, createFinalizationDependencies } from "../runtime";

const claim: FinalizationClaim = {
	jobId: "job",
	ownerId: "owner",
	mediaKind: "image",
	candidates: [
		{
			key: "attempt:0",
			output: {
				kind: "remote-url",
				url: "https://replicate.delivery/image.png",
				trust: "untrusted-transfer-candidate",
			},
		},
	],
};

function fixture(
	input: { contentLength?: string; mimeType?: string; placeholder?: Record<string, unknown> } = {},
) {
	const source = Readable.from([Buffer.alloc(32)]);
	const inspect = vi.fn(async () => ({
		stream: source,
		contentType: input.mimeType ?? "image/png",
		status: 200,
		headers: input.contentLength === undefined ? {} : { "content-length": input.contentLength },
		url: new URL("https://replicate.delivery/image.png"),
	}));
	const direct = vi.fn(async (_input: { reserve: (bytes: number) => Promise<void> }) => ({
		bytes: 32,
		sha256: "a".repeat(64),
		etag: "etag",
		versionId: null,
	}));
	const buffered = vi.fn();
	const staged = vi.fn();
	const promote = vi.fn();
	const verify = vi.fn();
	const database = {
		generationJob: { findUnique: vi.fn(async () => ({ id: "job" })) },
		mediaAsset: { findUnique: vi.fn(async () => input.placeholder ?? null) },
	};
	const dependencies = createFinalizationDependencies(process.env, {
		database: database as never,
		store: { findPersistedCandidate: async () => null } as never,
		streamingTransfersOnly: true,
		safety: new TestMediaSafetyAdapter("ALLOW"),
		verification: { verify },
		storage: {
			openInspectedRemoteMedia: inspect as never,
			tryWriteImmutableGenerationImage: direct,
			putPrivateMediaObject: buffered,
			streamRemoteObjectToStorage: staged,
			promoteStagedObject: promote,
		},
	});
	return {
		source,
		inspect,
		direct,
		buffered,
		staged,
		promote,
		verify,
		database,
		run: () => dependencies.persistCandidate(claim, claim.candidates[0]!),
	};
}

describe("streaming finalization admission", () => {
	beforeEach(() => {
		boundary.claim.mockReset().mockResolvedValue({
			outcome: "CLAIMED",
			asset: { status: "VERIFYING" },
			transferToken: "transfer",
			stagingObjectKey: "unused-staging",
			promotionMultipartUploadId: null,
		});
		boundary.complete.mockReset().mockResolvedValue({
			outcome: "COMPLETED",
			asset: { status: "VERIFYING" },
			outputReviewEventId: "review-event",
		});
		boundary.reserve.mockReset().mockResolvedValue({ outcome: "RESERVED" });
	});
	it("reserves the validated length with the claim and consumes it once before the private write", async () => {
		boundary.claim.mockResolvedValueOnce({
			outcome: "CLAIMED",
			freshAsset: true,
			reservedStorageBytes: 32n,
			asset: { status: "VERIFYING" },
			transferToken: "transfer",
			stagingObjectKey: "unused-staging",
			promotionMultipartUploadId: null,
		});
		const state = fixture({ contentLength: "32" });
		state.direct.mockImplementationOnce(async ({ reserve }) => {
			await reserve(32);
			expect(boundary.reserve).not.toHaveBeenCalled();
			await reserve(32);
			expect(boundary.reserve).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					assetId: expect.any(String),
					transferToken: "transfer",
					bytes: 32n,
				}),
				state.database,
			);
			return { bytes: 32, sha256: "a".repeat(64), etag: "etag", versionId: null };
		});
		await state.run();
		expect(boundary.claim).toHaveBeenCalledWith(
			expect.objectContaining({
				storageReservation: { bytes: 32n, maximumStorageBytes: expect.any(BigInt) },
			}),
			state.database,
		);
	});
	it.each([
		[false, 32n, 32],
		[undefined, 32n, 32],
		[true, undefined, 32],
		[true, 31n, 32],
		[true, 32n, 31],
	] as const)(
		"rechecks reservation for fresh=%s receipt=%s bytes=%s",
		async (freshAsset, reservedStorageBytes, bytes) => {
			boundary.claim.mockResolvedValueOnce({
				outcome: "CLAIMED",
				freshAsset,
				reservedStorageBytes,
				asset: { status: "VERIFYING" },
				transferToken: "transfer",
				stagingObjectKey: "unused-staging",
				promotionMultipartUploadId: null,
			});
			const state = fixture({ contentLength: "32" });
			state.direct.mockImplementationOnce(async ({ reserve }) => {
				await reserve(bytes);
				return { bytes, sha256: "a".repeat(64), etag: "etag", versionId: null };
			});
			await state.run();
			expect(boundary.reserve).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ transferToken: "transfer", bytes: BigInt(bytes) }),
				state.database,
			);
		},
	);
	it.each([true, false, undefined])(
		"only trusts freshAsset=%s from the committed transfer claim",
		async (freshAsset) => {
			boundary.claim.mockResolvedValueOnce({
				outcome: "CLAIMED",
				freshAsset,
				asset: { status: "VERIFYING" },
				transferToken: "transfer",
				stagingObjectKey: "unused-staging",
				promotionMultipartUploadId: null,
			});
			const f = fixture({ contentLength: "32" });
			await f.run();
			expect(f.direct).toHaveBeenCalledWith(
				expect.objectContaining({ freshClaim: freshAsset === true }),
			);
			expect(f.inspect).toHaveBeenCalledTimes(1);
		},
	);
	it("uses a bounded DB projection without Prisma loading the original envelope", async () => {
		const query = vi.fn(async () => [
			{
				jobId: "job",
				ownerType: "USER",
				ownerId: "owner",
				productKey: "image-nano-banana-2-lite",
				serviceClass: "STANDARD",
				guestTrialId: null,
				fundingSource: "CREDITS",
				attemptId: "attempt",
				outputs: [{ kind: "remote-url", url: "https://replicate.delivery/image.png" }],
			},
		]);
		const fullRead = vi.fn(async () => {
			throw new Error("FULL_ENVELOPE_READ_FORBIDDEN");
		});
		const store = createDatabaseFinalizationStore(
			{ $queryRaw: query, $transaction: fullRead, generationJob: { findFirst: fullRead } } as never,
			{ streamingTransfersOnly: true },
		);
		expect(await store.claimFinalization({ jobId: "job", version: 1 })).toEqual(claim);
		expect(fullRead).not.toHaveBeenCalled();
		const sql = (query.mock.calls[0] as unknown as [TemplateStringsArray])[0].join("?");
		expect(sql).toContain("jsonb_build_object('kind', 'remote-url', 'url', item->>'url')");
		expect(sql).toContain("LEFT JOIN");
		expect(sql).toContain("BETWEEN 1 AND 4096");
		expect(sql).not.toContain("responseSnapshot");
	});
	it.each([
		["inline/mixed/missing envelope", { outputs: null }],
		["guest", { serviceClass: "GUEST_SLOW" }],
		["non-image", { productKey: "video-seedance-2" }],
		[
			"malformed remote URL",
			{ outputs: [{ kind: "remote-url", url: "http://unsafe.example/image.png" }] },
		],
		[
			"inline projection defense",
			{ outputs: [{ kind: "inline-base64", mimeType: "image/png", data: "a".repeat(1000) }] },
		],
	] as const)("reroutes %s without reading a raw envelope", async (_name, change) => {
		const fullRead = vi.fn();
		const store = createDatabaseFinalizationStore(
			{
				$queryRaw: async () => [
					{
						jobId: "job",
						ownerType: "USER",
						ownerId: "owner",
						productKey: "image-nano-banana-2-lite",
						serviceClass: "STANDARD",
						guestTrialId: null,
						fundingSource: "CREDITS",
						attemptId: "attempt",
						outputs: [{ kind: "remote-url", url: "https://replicate.delivery/image.png" }],
						...change,
					},
				],
				$transaction: fullRead,
			} as never,
			{ streamingTransfersOnly: true },
		);
		await expect(store.claimFinalization({ jobId: "job", version: 1 })).rejects.toBeInstanceOf(
			GenerationTransferRequiresHeavyError,
		);
		expect(fullRead).not.toHaveBeenCalled();
	});
	it.each([undefined, "0", "999999999", "32x", "2e6"])(
		"closes GET with unsupported length %s before acquiring a transfer lease",
		async (contentLength) => {
			const state = fixture({ contentLength });
			await expect(state.run()).rejects.toBeInstanceOf(GenerationTransferRequiresHeavyError);
			expect(state.source.destroyed).toBe(true);
			expect(boundary.claim).not.toHaveBeenCalled();
			expect(state.direct).not.toHaveBeenCalled();
			expect(state.staged).not.toHaveBeenCalled();
		},
	);
	it("reroutes actual non-image MIME and closes the opened stream before claiming", async () => {
		const state = fixture({ contentLength: "32", mimeType: "video/mp4" });
		await expect(state.run()).rejects.toBeInstanceOf(GenerationTransferRequiresHeavyError);
		expect(state.source.destroyed).toBe(true);
		expect(boundary.claim).not.toHaveBeenCalled();
	});
	it.each([
		"outputTransferToken",
		"outputTransferLeaseExpiresAt",
		"outputStagingObjectKey",
		"outputPromotionMultipartUploadId",
	])("leaves existing %s recovery with heavy without claiming or opening GET", async (field) => {
		const state = fixture({
			contentLength: "32",
			placeholder: {
				ownerType: "USER",
				ownerId: "owner",
				kind: "OUTPUT",
				sourceUrl: "provider-output:attempt:0",
				status: "VERIFYING",
				mimeType: "image/png",
				[field]: "existing",
			},
		});
		await expect(state.run()).rejects.toBeInstanceOf(GenerationTransferRequiresHeavyError);
		expect(state.inspect).not.toHaveBeenCalled();
		expect(boundary.claim).not.toHaveBeenCalled();
	});
	it("closes GET when the atomic claim finds a concurrently created heavy transfer", async () => {
		boundary.claim.mockResolvedValue({ outcome: "REQUIRES_HEAVY" });
		const state = fixture({ contentLength: "32" });
		await expect(state.run()).rejects.toBeInstanceOf(GenerationTransferRequiresHeavyError);
		expect(state.source.destroyed).toBe(true);
		expect(state.direct).not.toHaveBeenCalled();
		expect(boundary.complete).not.toHaveBeenCalled();
	});
	it("writes only via the streaming contract and hands review to control", async () => {
		const state = fixture({ contentLength: "32" });
		expect(await state.run()).toMatchObject({
			approved: false,
			moderationPending: true,
			outputReviewEventId: "review-event",
		});
		expect(boundary.claim).toHaveBeenCalledWith(
			expect.objectContaining({ streamingTransfersOnly: true, deferOutputReview: true }),
			expect.anything(),
		);
		expect(state.direct).toHaveBeenCalledWith(
			expect.objectContaining({
				streamingOnly: true,
				openedSource: expect.objectContaining({ stream: state.source }),
			}),
		);
		expect(
			(state.direct.mock.calls[0] as unknown as [Record<string, unknown>])[0],
		).not.toHaveProperty("body");
		expect(state.source.destroyed).toBe(true);
		expect(state.buffered).not.toHaveBeenCalled();
		expect(state.staged).not.toHaveBeenCalled();
		expect(state.promote).not.toHaveBeenCalled();
		expect(state.verify).not.toHaveBeenCalled();
	});
});
