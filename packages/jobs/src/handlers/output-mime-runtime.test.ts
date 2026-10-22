import { Readable } from "node:stream";

import { TestMediaSafetyAdapter } from "@repo/ai";
import { openInspectedRemoteMedia } from "@repo/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinalizationClaim, FinalizationStore } from "../contracts";

const boundary = vi.hoisted(() => ({ claim: vi.fn(), reserve: vi.fn(), complete: vi.fn() }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", async () => ({
	...(await vi.importActual<typeof import("@repo/database")>("@repo/database")),
	claimGenerationOutputTransferTransaction: boundary.claim,
	reserveGenerationOutputStorageTransaction: boundary.reserve,
	completeGenerationOutputTransferTransaction: boundary.complete,
}));

import { createFinalizationDependencies } from "../runtime";

describe("provider output format detection", () => {
	beforeEach(() => {
		boundary.claim.mockReset().mockResolvedValue({
			outcome: "COMPLETED",
			asset: { id: "stored-output", status: "READY" },
		});
	});
	it("refuses a direct foreign-engine transfer before any remote inspection or storage claim", async () => {
		const inspect = vi.fn();
		const dependencies = createFinalizationDependencies(process.env, {
			database: { generationJob: { findUnique: async () => null } } as never,
			store: { findPersistedCandidate: vi.fn() } as unknown as FinalizationStore,
			safety: new TestMediaSafetyAdapter("ALLOW"),
			storage: { openInspectedRemoteMedia: inspect },
		});
		await expect(
			dependencies.persistCandidate(
				{ jobId: "video-job", ownerId: "test-owner", mediaKind: "video" } as FinalizationClaim,
				{
					key: "candidate",
					output: {
						kind: "remote-url",
						url: "https://example.com/video.mp4",
						trust: "untrusted-transfer-candidate",
					},
				},
			),
		).rejects.toThrow("LEGACY_EXECUTOR_NOT_MANAGED");
		expect(boundary.claim).not.toHaveBeenCalled();
		expect(inspect).not.toHaveBeenCalled();
	});

	it("uses the stored format for an active transfer without reading an expired provider URL", async () => {
		boundary.claim.mockResolvedValue({ outcome: "IN_PROGRESS", asset: { id: "stored-output" } });
		const inspect = vi.fn(async () => {
			throw new Error("Provider URL expired");
		});
		const dependencies = createFinalizationDependencies(process.env, {
			database: {
				generationJob: { findUnique: async () => ({ id: "test-job" }) },
				mediaAsset: {
					findUnique: async () => ({
						ownerType: "USER",
						ownerId: "test-owner",
						kind: "OUTPUT",
						sourceUrl: "provider-output:candidate-1",
						status: "VERIFYING",
						mimeType: "image/jpeg",
					}),
				},
			} as never,
			store: { findPersistedCandidate: async () => null } as unknown as FinalizationStore,
			safety: new TestMediaSafetyAdapter("ALLOW"),
			storage: { openInspectedRemoteMedia: inspect },
		});
		await expect(
			dependencies.persistCandidate(
				{ jobId: "test-job", ownerId: "test-owner", mediaKind: "image" } as FinalizationClaim,
				{
					key: "candidate-1",
					output: {
						kind: "remote-url",
						url: "https://replicate.delivery/expired.png",
						trust: "untrusted-transfer-candidate",
					},
				},
			),
		).rejects.toMatchObject({ code: "OUTPUT_TRANSFER_IN_PROGRESS", retryable: true });
		expect(inspect).not.toHaveBeenCalled();
		expect(boundary.claim).toHaveBeenCalledWith(
			expect.objectContaining({ mimeType: "image/jpeg" }),
			expect.anything(),
		);
	});

	it.each([
		["JPEG", "ffd8ffe000104a46494600010100000100", "image/jpeg"],
		["PNG", "89504e470d0a1a0a0000000d494844520000", "image/png"],
	] as const)(
		"uses detected %s bytes before claiming the immutable output key",
		async (_, hex, mime) => {
			const claim = {
				jobId: "test-job",
				ownerId: "test-owner",
				mediaKind: "image",
			} as FinalizationClaim;
			const dependencies = createFinalizationDependencies(process.env, {
				database: {
					generationJob: { findUnique: async () => ({ id: "test-job" }) },
					mediaAsset: { findUnique: async () => null },
				} as never,
				store: { findPersistedCandidate: async () => null } as unknown as FinalizationStore,
				safety: new TestMediaSafetyAdapter("ALLOW"),
				storage: {
					openInspectedRemoteMedia: (url, options) =>
						openInspectedRemoteMedia(url, {
							...options,
							resolve: async () => [{ address: "8.8.8.8", family: 4 }],
							request: async () => ({
								status: 200,
								headers: { "content-type": "application/octet-stream" },
								stream: Readable.from([Buffer.from(hex, "hex")]),
							}),
						}),
				},
			});
			await expect(
				dependencies.persistCandidate(claim, {
					key: "candidate-1",
					output: {
						kind: "remote-url",
						url: "https://replicate.delivery/output.png",
						trust: "untrusted-transfer-candidate",
					},
				}),
			).resolves.toMatchObject({ approved: true });
			expect(boundary.claim).toHaveBeenCalledWith(
				expect.objectContaining({ mimeType: mime }),
				expect.anything(),
			);
		},
	);
	it.each([false, true])(
		"reuses the opened stream through direct=%s and closes it after transfer",
		async (direct) => {
			const opened = {
				contentType: "image/png" as const,
				url: new URL("https://replicate.delivery/output.png"),
				status: 200,
				headers: { "content-length": "16" },
				stream: Readable.from([Buffer.from("89504e470d0a1a0a0000000d494844520000", "hex")]),
			};
			boundary.claim.mockResolvedValue({
				outcome: "CLAIMED",
				asset: { status: "VERIFYING" },
				transferToken: "lease",
				stagingObjectKey: "users/test/staging.png",
			});
			boundary.reserve.mockResolvedValue({ outcome: "RESERVED" });
			boundary.complete.mockResolvedValue({ outcome: "COMPLETED", asset: { status: "READY" } });
			const persisted = { bytes: 16, sha256: "a".repeat(64), etag: "etag", versionId: null };
			const write = vi.fn(async (input: { openedSource?: unknown }) => {
				expect(input.openedSource).toBe(opened);
				expect(opened.stream.destroyed).toBe(false);
				return direct ? persisted : null;
			});
			const stage = vi.fn(async (input: { openedSource?: unknown }) => {
				expect(input.openedSource).toBe(opened);
				expect(opened.stream.destroyed).toBe(false);
				return persisted;
			});
			const dependencies = createFinalizationDependencies(process.env, {
				database: {
					generationJob: { findUnique: async () => ({ id: "job" }) },
					mediaAsset: { findUnique: async () => null },
				} as never,
				store: { findPersistedCandidate: async () => null } as unknown as FinalizationStore,
				verification: { verify: vi.fn() },
				storage: {
					openInspectedRemoteMedia: async () => opened,
					tryWriteImmutableGenerationImage: write,
					streamRemoteObjectToStorage: stage,
					promoteStagedObject: async () => persisted,
				},
			});
			await expect(
				dependencies.persistCandidate(
					{ jobId: "job", ownerId: "test", mediaKind: "image" } as FinalizationClaim,
					{
						key: "candidate",
						output: {
							kind: "remote-url",
							url: opened.url.href,
							trust: "untrusted-transfer-candidate",
						},
					},
				),
			).resolves.toMatchObject({ approved: true });
			expect(write).toHaveBeenCalledTimes(1);
			expect(stage).toHaveBeenCalledTimes(direct ? 0 : 1);
			expect(opened.stream.destroyed).toBe(true);
		},
	);
	it("closes the opened provider stream when the database claim fails", async () => {
		const source = Readable.from([Buffer.from("89504e470d0a1a0a", "hex")]);
		boundary.claim.mockRejectedValue(new Error("DATABASE_UNAVAILABLE"));
		const dependencies = createFinalizationDependencies(process.env, {
			database: {
				generationJob: { findUnique: async () => ({ id: "job" }) },
				mediaAsset: { findUnique: async () => null },
			} as never,
			store: { findPersistedCandidate: async () => null } as unknown as FinalizationStore,
			verification: { verify: vi.fn() },
			storage: {
				openInspectedRemoteMedia: async () => ({
					contentType: "image/png",
					url: new URL("https://replicate.delivery/output.png"),
					status: 200,
					headers: {},
					stream: source,
				}),
			},
		});
		await expect(
			dependencies.persistCandidate(
				{ jobId: "job", ownerId: "test", mediaKind: "image" } as FinalizationClaim,
				{
					key: "candidate",
					output: {
						kind: "remote-url",
						url: "https://replicate.delivery/output.png",
						trust: "untrusted-transfer-candidate",
					},
				},
			),
		).rejects.toThrow("DATABASE_UNAVAILABLE");
		expect(source.destroyed).toBe(true);
	});
	it("releases the source before returning a committed first-review continuation without calling moderation", async () => {
		const source = Readable.from([Buffer.from("89504e470d0a1a0a", "hex")]);
		boundary.claim.mockResolvedValue({
			outcome: "CLAIMED",
			asset: { status: "VERIFYING" },
			transferToken: "transfer-token",
			stagingObjectKey: "private/staging.png",
		});
		boundary.complete.mockResolvedValue({
			outcome: "COMPLETED",
			asset: { status: "VERIFYING" },
			outputReviewEventId: "committed-first-review",
		});
		const verify = vi.fn();
		const existing = vi.fn(async () => null);
		const readAsset = vi.fn(async () => null);
		const dependencies = createFinalizationDependencies(process.env, {
			deferOutputReview: true,
			database: {
				generationJob: { findUnique: async () => ({ id: "job" }) },
				mediaAsset: { findUnique: readAsset },
			} as never,
			store: { findPersistedCandidate: existing } as unknown as FinalizationStore,
			verification: { verify },
			storage: {
				openInspectedRemoteMedia: async () => ({
					contentType: "image/png",
					url: new URL("https://replicate.delivery/output.png"),
					status: 200,
					headers: {},
					stream: source,
				}),
				tryWriteImmutableGenerationImage: async () => ({
					bytes: 16,
					sha256: "a".repeat(64),
					etag: "etag",
					versionId: null,
				}),
			},
		});
		await expect(
			dependencies.persistCandidate(
				{ jobId: "job", ownerId: "test", mediaKind: "image" } as FinalizationClaim,
				{
					key: "candidate",
					output: {
						kind: "remote-url",
						url: "https://replicate.delivery/output.png",
						trust: "untrusted-transfer-candidate",
					},
				},
				{ persistedCandidateChecked: true },
			),
		).resolves.toMatchObject({
			approved: false,
			moderationPending: true,
			outputReviewEventId: "committed-first-review",
		});
		expect(verify).not.toHaveBeenCalled();
		expect(existing).not.toHaveBeenCalled();
		expect(readAsset).toHaveBeenCalledOnce();
		expect(source.destroyed).toBe(true);
		expect(boundary.claim).toHaveBeenCalledWith(
			expect.objectContaining({ deferOutputReview: true }),
			expect.anything(),
		);
		expect(boundary.complete).toHaveBeenCalledWith(
			expect.objectContaining({ deferOutputReview: true }),
			expect.anything(),
		);
	});
	it.each([false, true])(
		"retains legacy review and recovers deferred=%s without reopening provider output",
		async (deferOutputReview) => {
			boundary.claim.mockResolvedValue({
				outcome: "COMPLETED",
				asset: { status: "VERIFYING" },
				outputReviewEventId: "persisted-first-review",
			});
			const inspect = vi.fn();
			const verify = vi.fn(async () => undefined);
			const dependencies = createFinalizationDependencies(process.env, {
				deferOutputReview,
				database: {
					generationJob: { findUnique: async () => ({ id: "job" }) },
					mediaAsset: {
						findUnique: async () => ({
							ownerType: "USER",
							ownerId: "test",
							kind: "OUTPUT",
							sourceUrl: "provider-output:candidate",
							mimeType: "image/png",
							status: "VERIFYING",
						}),
						findUniqueOrThrow: async () => ({ status: "READY" }),
					},
				} as never,
				store: { findPersistedCandidate: async () => null } as unknown as FinalizationStore,
				verification: { verify },
				storage: { openInspectedRemoteMedia: inspect },
			});
			await expect(
				dependencies.persistCandidate(
					{ jobId: "job", ownerId: "test", mediaKind: "image" } as FinalizationClaim,
					{
						key: "candidate",
						output: {
							kind: "remote-url",
							url: "https://replicate.delivery/expired.png",
							trust: "untrusted-transfer-candidate",
						},
					},
				),
			).resolves.toMatchObject(
				deferOutputReview
					? {
							approved: false,
							moderationPending: true,
							outputReviewEventId: "persisted-first-review",
						}
					: { approved: true },
			);
			expect(inspect).not.toHaveBeenCalled();
			expect(verify).toHaveBeenCalledTimes(deferOutputReview ? 0 : 1);
		},
	);
});
