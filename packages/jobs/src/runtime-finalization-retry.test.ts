import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FinalizationClaim, FinalizationStore } from "./contracts";

const boundary = vi.hoisted(() => ({
	claim: vi.fn(),
	reserve: vi.fn(),
	complete: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", async () => ({
	...(await vi.importActual<typeof import("@repo/database")>("@repo/database")),
	claimGenerationOutputTransferTransaction: boundary.claim,
	reserveGenerationOutputStorageTransaction: boundary.reserve,
	completeGenerationOutputTransferTransaction: boundary.complete,
}));

import { finalizeMedia } from "./handlers/finalize-media";
import { createFinalizationDependencies } from "./runtime";

const claim: FinalizationClaim = {
	jobId: "finalization-retry-job",
	ownerId: "finalization-retry-owner",
	mediaKind: "image",
	candidates: [
		{
			key: "attempt:0",
			output: {
				kind: "remote-url",
				url: "https://replicate.delivery/output.png",
				trust: "untrusted-transfer-candidate",
			},
		},
	],
};

function harness() {
	const bytes = Buffer.from("89504e470d0a1a0a0000000d494844520000", "hex");
	const source = Readable.from([bytes]);
	const opened = {
		contentType: "image/png" as const,
		url: new URL("https://replicate.delivery/output.png"),
		status: 200,
		headers: { "content-length": String(bytes.length) },
		stream: source,
	};
	const open = vi.fn(async () => opened);
	const write = vi.fn(
		async (input: { openedSource?: unknown; reserve(bytes: number): Promise<void> }) => {
			expect(input.openedSource).toBe(opened);
			expect(source.destroyed).toBe(false);
			await input.reserve(bytes.length);
			const received: Buffer[] = [];
			for await (const chunk of source) received.push(Buffer.from(chunk));
			expect(Buffer.concat(received)).toEqual(bytes);
			return { bytes: bytes.length, sha256: "a".repeat(64), etag: "etag", versionId: null };
		},
	);
	const store = {
		claimFinalization: vi.fn(async () => claim),
		findPersistedCandidate: vi.fn(async () => null),
		recordFinalization: vi.fn(async () => undefined),
		recordFinalizationRetry: vi.fn(async () => ({
			outcome: "RETRY_SCHEDULED" as const,
			retryCount: 1,
			retryEvent: { id: "business-transfer-retry", availableAt: Date.now() + 120_000 },
		})),
	} satisfies FinalizationStore;
	const dependencies = createFinalizationDependencies(process.env, {
		streamingTransfersOnly: true,
		database: {
			generationJob: { findUnique: async () => ({ id: claim.jobId }) },
			mediaAsset: { findUnique: async () => null },
		} as never,
		store,
		verification: { verify: vi.fn() },
		storage: { openInspectedRemoteMedia: open, tryWriteImmutableGenerationImage: write },
	});
	return { dependencies, store, open, write, source };
}

beforeEach(() => {
	vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true");
	boundary.claim.mockReset().mockResolvedValue({
		outcome: "CLAIMED",
		asset: { status: "VERIFYING" },
		transferToken: "transfer-fence",
		stagingObjectKey: "private/staging.png",
	});
	boundary.reserve.mockReset().mockResolvedValue({ outcome: "RESERVED" });
	boundary.complete.mockReset().mockResolvedValue({
		outcome: "COMPLETED",
		asset: { status: "READY" },
	});
});

afterEach(() => vi.unstubAllEnvs());

describe.each(["true", "false"])(
	"finalization database retry budget with fresh reads %s",
	(flag) => {
		it.each(["claim", "reserve", "complete"] as const)(
			"caps %s at the selected isolation branch's transaction budget",
			async (stage) => {
				vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", flag);
				const actual = await vi.importActual<typeof import("@repo/database")>("@repo/database");
				const failure = Object.assign(new Error("confirmed database rollback"), { code: "P2034" });
				const transaction = vi.fn().mockRejectedValue(failure);
				const helpers = {
					claim: actual.claimGenerationOutputTransferTransaction,
					reserve: actual.reserveGenerationOutputStorageTransaction,
					complete: actual.completeGenerationOutputTransferTransaction,
				};
				boundary[stage].mockImplementation((input) =>
					helpers[stage](input, { $transaction: transaction } as never),
				);
				const { dependencies, store, open, write, source } = harness();
				const operation = finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies);
				if (stage === "claim") {
					await expect(operation).rejects.toMatchObject({
						code: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
						phase: "BEFORE_TRANSFER_LEASE",
					});
					expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
				} else {
					await expect(operation).resolves.toMatchObject({ outcome: "RETRY_SCHEDULED" });
					expect(store.recordFinalizationRetry).toHaveBeenCalledOnce();
				}
				expect(transaction).toHaveBeenCalledTimes(flag === "true" ? 3 : 4);
				expect(boundary[stage]).toHaveBeenCalledTimes(flag === "true" ? 3 : 1);
				expect(open).toHaveBeenCalledOnce();
				expect(write).toHaveBeenCalledTimes(stage === "claim" ? 0 : 1);
				expect(source.destroyed).toBe(true);
			},
		);

		it.each(["claim", "reserve", "complete"] as const)(
			"never retries an unknown %s commit outcome through either layer",
			async (stage) => {
				vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", flag);
				const actual = await vi.importActual<typeof import("@repo/database")>("@repo/database");
				const failure = Object.assign(new Error("response lost after possible commit"), {
					code: "P1001",
				});
				const transaction = vi.fn().mockRejectedValue(failure);
				const helpers = {
					claim: actual.claimGenerationOutputTransferTransaction,
					reserve: actual.reserveGenerationOutputStorageTransaction,
					complete: actual.completeGenerationOutputTransferTransaction,
				};
				boundary[stage].mockImplementation((input) =>
					helpers[stage](input, { $transaction: transaction } as never),
				);
				const { dependencies, open, write, source } = harness();
				if (stage === "claim") {
					await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toBe(
						failure,
					);
				} else {
					await expect(
						finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies),
					).resolves.toMatchObject({ outcome: "RETRY_SCHEDULED" });
				}
				expect(transaction).toHaveBeenCalledOnce();
				expect(boundary[stage]).toHaveBeenCalledOnce();
				expect(open).toHaveBeenCalledOnce();
				expect(write).toHaveBeenCalledTimes(stage === "claim" ? 0 : 1);
				expect(source.destroyed).toBe(true);
			},
		);
	},
);

describe("finalization database conflict before the transfer lease", () => {
	it.each([
		{ code: "P2034" },
		{ meta: { driverAdapterError: { cause: { originalCode: "40001" } } } },
		{ cause: { kind: "TransactionWriteConflict" } },
	])("retries a rolled-back claim without reopening the provider stream (%j)", async (details) => {
		boundary.claim.mockRejectedValueOnce(Object.assign(new Error("database conflict"), details));
		const { dependencies, store, open, write, source } = harness();
		await expect(finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies)).resolves.toEqual({
			outcome: "FINALIZED",
			readyOutputs: 1,
		});
		expect(boundary.claim).toHaveBeenCalledTimes(2);
		expect(open).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledOnce();
		expect(boundary.reserve).toHaveBeenCalledOnce();
		expect(boundary.complete).toHaveBeenCalledOnce();
		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
		expect(store.recordFinalization).toHaveBeenCalledOnce();
		expect(source.destroyed).toBe(true);
	});

	it.each([
		Object.assign(new Error("database connection lost"), { code: "P1001" }),
		new Error("could not serialize; text without an authoritative database code"),
	])("does not retry an unknown claim outcome (%s)", async (failure) => {
		boundary.claim.mockRejectedValueOnce(failure);
		const { dependencies, open, write, source } = harness();
		await expect(dependencies.persistCandidate(claim, claim.candidates[0]!)).rejects.toBe(failure);
		expect(boundary.claim).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(boundary.reserve).not.toHaveBeenCalled();
		expect(boundary.complete).not.toHaveBeenCalled();
		expect(source.destroyed).toBe(true);
	});

	it("returns exhausted rollback conflicts to task recovery without spending transfer retries", async () => {
		boundary.claim.mockRejectedValue(
			Object.assign(new Error("database conflict"), { code: "P2034" }),
		);
		const { dependencies, store, open, write, source } = harness();
		await expect(
			finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies),
		).rejects.toMatchObject({
			code: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
			phase: "BEFORE_TRANSFER_LEASE",
		});
		expect(boundary.claim).toHaveBeenCalledTimes(3);
		expect(open).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(boundary.reserve).not.toHaveBeenCalled();
		expect(boundary.complete).not.toHaveBeenCalled();
		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
		expect(store.recordFinalization).not.toHaveBeenCalled();
		expect(source.destroyed).toBe(true);
	});

	it("does not accept a lookalike pre-transfer marker as proof of a rolled-back claim", async () => {
		boundary.claim.mockRejectedValueOnce({
			code: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
			phase: "BEFORE_TRANSFER_LEASE",
		});
		const { dependencies, store, open, write } = harness();
		await expect(
			finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies),
		).resolves.toMatchObject({
			outcome: "RETRY_SCHEDULED",
		});
		expect(boundary.claim).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledOnce();
		expect(write).not.toHaveBeenCalled();
		expect(store.recordFinalizationRetry).toHaveBeenCalledOnce();
	});

	it.each(["reserve", "complete"] as const)(
		"retries only the rolled-back %s transaction under the same transfer fence",
		async (stage) => {
			boundary[stage].mockRejectedValueOnce(
				Object.assign(new Error("database conflict after lease acquisition"), { code: "P2034" }),
			);
			const { dependencies, store, open, write, source } = harness();
			await expect(
				finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies),
			).resolves.toEqual({
				outcome: "FINALIZED",
				readyOutputs: 1,
			});
			expect(boundary.claim).toHaveBeenCalledOnce();
			expect(open).toHaveBeenCalledOnce();
			expect(write).toHaveBeenCalledOnce();
			expect(boundary.reserve).toHaveBeenCalledTimes(stage === "reserve" ? 2 : 1);
			expect(boundary.complete).toHaveBeenCalledTimes(stage === "complete" ? 2 : 1);
			expect(boundary[stage].mock.calls[0]![0]).toEqual(boundary[stage].mock.calls[1]![0]);
			expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
			expect(source.destroyed).toBe(true);
		},
	);

	it.each(["reserve", "complete"] as const)(
		"preserves fenced storage recovery when %s keeps conflicting",
		async (stage) => {
			boundary[stage].mockRejectedValue(
				Object.assign(new Error("database conflict after lease acquisition"), { code: "P2034" }),
			);
			const { dependencies, store, open, write, source } = harness();
			await expect(
				finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies),
			).resolves.toMatchObject({
				outcome: "RETRY_SCHEDULED",
				retryEvent: { id: "business-transfer-retry" },
			});
			expect(boundary.claim).toHaveBeenCalledOnce();
			expect(boundary[stage]).toHaveBeenCalledTimes(3);
			expect(open).toHaveBeenCalledOnce();
			expect(write).toHaveBeenCalledOnce();
			expect(store.recordFinalizationRetry).toHaveBeenCalledExactlyOnceWith(
				claim,
				expect.objectContaining({
					code: "STORAGE_TRANSFER_RETRYABLE",
					stage: "TRANSFER",
					transferToken: "transfer-fence",
					candidateKey: claim.candidates[0]!.key,
				}),
				[],
			);
			expect(source.destroyed).toBe(true);
		},
	);

	it.each(["reserve", "complete"] as const)(
		"does not retry an unknown %s commit outcome",
		async (stage) => {
			boundary[stage].mockRejectedValueOnce(new Error("database response lost after commit"));
			const { dependencies, store, open, write } = harness();
			await expect(
				finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies),
			).resolves.toMatchObject({
				outcome: "RETRY_SCHEDULED",
			});
			expect(boundary[stage]).toHaveBeenCalledOnce();
			expect(boundary.claim).toHaveBeenCalledOnce();
			expect(open).toHaveBeenCalledOnce();
			expect(write).toHaveBeenCalledOnce();
			expect(store.recordFinalizationRetry).toHaveBeenCalledExactlyOnceWith(
				claim,
				expect.objectContaining({
					code: "STORAGE_TRANSFER_RETRYABLE",
					transferToken: "transfer-fence",
				}),
				[],
			);
		},
	);

	it.each(["reserve", "complete"] as const)(
		"honors the expired transfer fence returned by a repeated %s transaction",
		async (stage) => {
			boundary[stage]
				.mockRejectedValueOnce(Object.assign(new Error("database rollback"), { code: "P2034" }))
				.mockResolvedValueOnce({ outcome: "STALE", asset: { status: "VERIFYING" } });
			const { dependencies, store, open, write } = harness();
			await expect(
				finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies),
			).resolves.toMatchObject({
				outcome: "RETRY_SCHEDULED",
			});
			expect(boundary[stage]).toHaveBeenCalledTimes(2);
			expect(boundary.claim).toHaveBeenCalledOnce();
			expect(open).toHaveBeenCalledOnce();
			expect(write).toHaveBeenCalledOnce();
			expect(store.recordFinalizationRetry).toHaveBeenCalledExactlyOnceWith(
				claim,
				expect.objectContaining({
					code: "OUTPUT_TRANSFER_FENCE_LOST",
					transferToken: "transfer-fence",
				}),
				[],
			);
		},
	);

	it("reuses the actual immutable winner identity when its database completion rolls back", async () => {
		boundary.complete.mockRejectedValueOnce(
			Object.assign(new Error("database rollback after immutable write"), { code: "P2034" }),
		);
		const { dependencies, store, open, write, source } = harness();
		write.mockResolvedValueOnce({
			bytes: 93,
			sha256: "b".repeat(64),
			etag: "existing-winner-etag",
			versionId: null,
		});
		await expect(
			finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies),
		).resolves.toMatchObject({
			outcome: "FINALIZED",
		});
		expect(boundary.complete).toHaveBeenCalledTimes(2);
		for (const [input] of boundary.complete.mock.calls)
			expect(input).toMatchObject({
				transferToken: "transfer-fence",
				bytes: 93n,
				checksum: "b".repeat(64),
				storageEtag: "existing-winner-etag",
				storageVersionId: null,
			});
		expect(open).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledOnce();
		expect(store.recordFinalizationRetry).not.toHaveBeenCalled();
		expect(source.destroyed).toBe(true);
	});

	it("never treats a storage error with a database-looking code as a rolled-back transaction", async () => {
		const { dependencies, store, open, write } = harness();
		write.mockRejectedValueOnce(Object.assign(new Error("storage failed"), { code: "P2034" }));
		await expect(
			finalizeMedia({ jobId: claim.jobId, version: 0 }, dependencies),
		).resolves.toMatchObject({
			outcome: "RETRY_SCHEDULED",
		});
		expect(open).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledOnce();
		expect(boundary.claim).toHaveBeenCalledOnce();
		expect(boundary.complete).not.toHaveBeenCalled();
		expect(store.recordFinalizationRetry).toHaveBeenCalledExactlyOnceWith(
			claim,
			expect.objectContaining({
				code: "STORAGE_TRANSFER_RETRYABLE",
				transferToken: "transfer-fence",
			}),
			[],
		);
	});
});
