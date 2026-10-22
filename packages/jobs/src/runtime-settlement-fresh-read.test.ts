import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const funding = vi.hoisted(() => ({
	lookup: vi.fn(),
	settle: vi.fn(),
	finalizePass: vi.fn(),
	grace: vi.fn(),
	approved: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	SERIALIZABLE_RETRY_LIMIT: 4,
	getGenerationFundingReservation: funding.lookup,
	settleCreditsInTransaction: funding.settle,
	finalizeImagePassReservationInTransaction: funding.finalizePass,
	claimOutputModerationGraceInTransaction: funding.grace,
	hasCurrentApprovedMediaAssetEvidence: funding.approved,
	isDatabaseSerializationConflict: (error: { code?: string } | null) => error?.code === "P2034",
	isDatabaseLockNotAvailable: (error: { code?: string } | null) => error?.code === "55P03",
	runReadCommitted: async (
		database: { $transaction: (...args: unknown[]) => unknown },
		operation: unknown,
	) => database.$transaction(operation, { isolationLevel: "ReadCommitted" }),
	runSerializable: async (
		database: { $transaction: (...args: unknown[]) => unknown },
		operation: unknown,
	) => database.$transaction(operation, { isolationLevel: "Serializable" }),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { SettlementTransactionConflictError, type SettlementClaim } from "./contracts";
import { settleGeneration } from "./handlers/settle-generation";
import { createDatabaseSettlementStore } from "./runtime";

const payload = { jobId: "job", version: 7 };
const oldClaim: SettlementClaim = {
	jobId: "job",
	reservationId: "untrusted-old-claim",
	reservedCredits: 999n,
	chargeCredits: 999n,
	readyOutputCount: 99,
	providerCostMicros: 0n,
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("MEDIA_SETTLEMENT_FRESH_READ_ENABLED", "true");
	funding.approved.mockImplementation(
		(asset, { now }) =>
			asset.approved && (!asset.verificationValidUntil || asset.verificationValidUntil > now),
	);
});
afterEach(() => vi.unstubAllEnvs());

function fixture() {
	const operations: string[] = [];
	const job = {
		id: "job",
		version: 7,
		ownerType: "USER",
		ownerId: "owner",
		status: "FINALIZING",
		fundingSource: "CREDITS",
		creditsReserved: 5n,
		guestTrialId: null,
		serviceClass: "STANDARD",
		failureCode: null,
		pricingSnapshot: {
			settlementPolicy: { unitCredits: "5", requestedOutputCount: 1, maxCharge: "5" },
		},
		reservation: { id: "reservation", accountId: "account", amount: 5n, status: "ACTIVE" },
		assets: [
			{
				assetId: "output",
				assetChecksum: "checksum",
				asset: {
					id: "output",
					status: "READY",
					kind: "OUTPUT",
					mimeType: "image/png",
					checksum: "checksum",
					deletedAt: null,
					approved: true,
					verificationValidUntil: new Date("2030-01-01T00:00:00Z"),
					moderationResults: [],
				},
			},
		],
		attempts: [],
	};
	const state = {
		now: new Date("2029-01-01T00:00:00Z"),
		account: { id: "account", ownerType: "USER", ownerId: "owner" },
		jobPresent: true,
	};
	const tx = {
		generationJob: {
			findFirst: vi.fn(async (query: { select?: unknown }) => {
				operations.push(query.select ? "discover" : "evidence");
				return structuredClone(job);
			}),
			updateMany: vi.fn(async () => {
				operations.push("terminal");
				return { count: 1 };
			}),
		},
		generationJobAsset: {
			findMany: vi.fn(async () => {
				operations.push("bindings");
				return job.assets.map(({ assetId, assetChecksum }) => ({ assetId, assetChecksum }));
			}),
		},
		$executeRaw: vi.fn(async (_query: unknown, key: unknown) => {
			operations.push(String(key));
			return 1;
		}),
		$queryRaw: vi.fn(async (query: TemplateStringsArray) => {
			const sql = query.join("?");
			if (sql.includes('FROM "credit_account"')) {
				operations.push("account-lock");
				return [state.account];
			}
			if (sql.includes('FROM "generation_job"')) {
				expect(sql).toContain("FOR UPDATE NOWAIT");
				operations.push("job-lock");
				return state.jobPresent ? [{ id: job.id }] : [];
			}
			if (sql.includes('FROM "media_asset"')) {
				expect(sql).toContain("FOR UPDATE NOWAIT");
				operations.push("asset-lock");
				return job.assets.map(({ assetId }) => ({ id: assetId }));
			}
			expect(sql).toContain('clock_timestamp() AS "now"');
			operations.push("clock");
			return [{ now: state.now }];
		}),
	};
	const database = {
		...tx,
		$transaction: vi.fn(
			async (operation: (client: typeof tx) => Promise<unknown>, _options: unknown) =>
				operation(tx),
		),
	};
	funding.lookup.mockImplementation(async (_id, _tx, known) =>
		known
			? { ...known, fundingSource: "CREDITS" }
			: { id: "pass", amount: 1n, status: "ACTIVE", fundingSource: "IMAGE_PASS" },
	);
	funding.settle.mockImplementation(async () => {
		operations.push("settle");
	});
	const store = createDatabaseSettlementStore(database as never);
	return { job, state, tx, database, store, operations };
}

describe("fresh-read credit settlement", () => {
	it.each([undefined, "false", "TRUE", "1"])(
		"defaults to the legacy path for %s",
		async (value) => {
			vi.stubEnv("MEDIA_SETTLEMENT_FRESH_READ_ENABLED", value);
			const f = fixture();
			expect(await f.store.settleForJob!(payload)).toBeNull();
			expect(f.database.$transaction).not.toHaveBeenCalled();
		},
	);

	it("settles directly from committed locked evidence without an outer claim graph", async () => {
		const f = fixture();
		const claim = vi.spyOn(f.store, "claimSettlement");
		expect(await settleGeneration(payload, { store: f.store })).toEqual({ outcome: "SETTLED" });
		expect(claim).not.toHaveBeenCalled();
		expect(f.operations).toEqual([
			"discover",
			"media-verification:output",
			"account-lock",
			"job-lock",
			"bindings",
			"asset-lock",
			"evidence",
			"clock",
			"settle",
			"terminal",
		]);
		expect(f.database.$transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
			isolationLevel: "ReadCommitted",
		});
		expect(funding.settle).toHaveBeenCalledWith(
			{ reservationId: "reservation", amount: 5n, referenceKey: "settle:job" },
			f.tx,
		);
		expect(f.tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					version: 7,
					fundingSource: "CREDITS",
					status: "FINALIZING",
				}),
				data: expect.objectContaining({ status: "SUCCEEDED", terminalAt: f.state.now }),
			}),
		);
	});

	it("ignores stale claim amounts and settles the authoritative job", async () => {
		const f = fixture();
		await f.store.settle(oldClaim);
		expect(funding.settle).toHaveBeenCalledWith(
			expect.objectContaining({ reservationId: "reservation", amount: 5n }),
			f.tx,
		);
	});

	it("keeps IMAGE_PASS on its original serializable consumer", async () => {
		const f = fixture();
		Object.assign(f.job, { fundingSource: "IMAGE_PASS", creditsReserved: 0n, reservation: null });
		expect(await settleGeneration(payload, { store: f.store })).toEqual({ outcome: "SETTLED" });
		expect(f.database.$transaction.mock.calls.map(([, options]) => options)).toEqual([
			{ isolationLevel: "ReadCommitted" },
			{ isolationLevel: "Serializable" },
		]);
		expect(funding.finalizePass).toHaveBeenCalledOnce();
		expect(funding.settle).not.toHaveBeenCalled();
	});

	it("rechecks moderation after the asset lock and uses database wall time", async () => {
		const f = fixture();
		f.state.now = new Date("2031-01-01T00:00:00Z");
		expect(await f.store.settleForJob!(payload)).toEqual({ outcome: "SKIPPED" });
		expect(funding.approved).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ now: f.state.now }),
		);
		expect(funding.settle).not.toHaveBeenCalled();
		expect(f.tx.generationJob.updateMany).not.toHaveBeenCalled();
	});

	it("does not use an earlier READY result when the locked read is VERIFYING", async () => {
		const f = fixture();
		f.tx.generationJob.findFirst.mockImplementation(async ({ select }) => {
			const read = structuredClone(f.job);
			if (!select) read.assets[0]!.asset.status = "VERIFYING";
			return read;
		});
		expect(await f.store.settleForJob!(payload)).toEqual({ outcome: "SKIPPED" });
		expect(funding.settle).not.toHaveBeenCalled();
	});

	it("restarts discovery rather than appending advisory locks after a changed binding set", async () => {
		const f = fixture();
		f.tx.generationJobAsset.findMany.mockResolvedValueOnce([]);
		expect(await f.store.settleForJob!(payload)).toEqual({ outcome: "SETTLED" });
		expect(f.database.$transaction).toHaveBeenCalledTimes(2);
		expect(f.operations).toEqual([
			"discover",
			"media-verification:output",
			"account-lock",
			"job-lock",
			"discover",
			"media-verification:output",
			"account-lock",
			"job-lock",
			"bindings",
			"asset-lock",
			"evidence",
			"clock",
			"settle",
			"terminal",
		]);
	});

	it("detects a newly added binding even when the original set was empty", async () => {
		const f = fixture();
		f.job.assets = [];
		f.tx.generationJobAsset.findMany.mockResolvedValue([
			{ assetId: "new-output", assetChecksum: "checksum" },
		]);
		await expect(f.store.settleForJob!(payload)).rejects.toMatchObject({
			code: "SETTLEMENT_TRANSACTION_CONFLICT",
			cause: { code: "SETTLEMENT_FRESH_READ_CONFLICT", reason: "OUTPUT_BINDINGS_CHANGED" },
		});
		expect(f.database.$transaction).toHaveBeenCalledTimes(4);
		expect(funding.settle).not.toHaveBeenCalled();
	});

	it.each(["checksum", "account", "amount"])(
		"retries changed %s evidence as an internal rollback",
		async (change) => {
			const f = fixture();
			f.tx.generationJob.findFirst.mockImplementation(async ({ select }) => {
				const read = structuredClone(f.job);
				if (!select) {
					if (change === "checksum") read.assets[0]!.assetChecksum = "new-checksum";
					if (change === "account") read.reservation.accountId = "new-account";
					if (change === "amount") read.reservation.amount = 9n;
				}
				return read;
			});
			await expect(f.store.settleForJob!(payload)).rejects.toMatchObject({
				cause: { code: "SETTLEMENT_FRESH_READ_CONFLICT" },
			});
			expect(f.database.$transaction).toHaveBeenCalledTimes(4);
			expect(funding.settle).not.toHaveBeenCalled();
		},
	);

	it("shares four attempts across internal read changes and real database conflicts", async () => {
		const f = fixture();
		f.tx.generationJobAsset.findMany.mockResolvedValueOnce([]);
		f.database.$transaction
			.mockRejectedValueOnce({ code: "55P03" })
			.mockRejectedValueOnce({ code: "P2034" });
		expect(await f.store.settleForJob!(payload)).toEqual({ outcome: "SETTLED" });
		expect(f.database.$transaction).toHaveBeenCalledTimes(4);
	});

	it("does not retry an unknown commit result", async () => {
		const f = fixture();
		const unknown = new Error("connection lost at commit");
		f.database.$transaction.mockRejectedValueOnce(unknown);
		await expect(f.store.settleForJob!(payload)).rejects.toBe(unknown);
		expect(f.database.$transaction).toHaveBeenCalledOnce();
		expect(unknown).not.toBeInstanceOf(SettlementTransactionConflictError);
	});

	it("repairs a finalized reservation only under all locks, without another financial mutation", async () => {
		const f = fixture();
		f.job.reservation.status = "SETTLED";
		expect(await f.store.claimSettlement(payload)).toBeNull();
		expect(f.database.$transaction).toHaveBeenCalledOnce();
		expect(f.operations.indexOf("asset-lock")).toBeLessThan(f.operations.indexOf("terminal"));
		expect(f.tx.generationJob.updateMany).toHaveBeenCalledOnce();
		expect(funding.settle).not.toHaveBeenCalled();
	});

	it("fences default-off non-active repairs after an outdated outer READY read", async () => {
		vi.stubEnv("MEDIA_SETTLEMENT_FRESH_READ_ENABLED", undefined);
		const f = fixture();
		f.job.reservation.status = "SETTLED";
		let reads = 0;
		f.tx.generationJob.findFirst.mockImplementation(async () => {
			const read = structuredClone(f.job);
			if (reads++ > 0) read.assets[0]!.asset.status = "VERIFYING";
			return read;
		});
		expect(await f.store.claimSettlement(payload)).toBeNull();
		expect(f.database.$transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
			isolationLevel: "Serializable",
		});
		expect(f.tx.generationJob.updateMany).not.toHaveBeenCalled();
		expect(funding.settle).not.toHaveBeenCalled();
	});

	it("rolls back and retries a lost terminal CAS with the same budget", async () => {
		const f = fixture();
		f.tx.generationJob.updateMany.mockResolvedValue({ count: 0 });
		await expect(f.store.settleForJob!(payload)).rejects.toMatchObject({
			cause: { reason: "JOB_CHANGED" },
		});
		expect(f.database.$transaction).toHaveBeenCalledTimes(4);
	});

	it("preserves cancellation and settles zero", async () => {
		const f = fixture();
		f.job.status = "CANCELED";
		expect(await f.store.settleForJob!(payload)).toEqual({ outcome: "SETTLED" });
		expect(funding.settle).toHaveBeenCalledWith(expect.objectContaining({ amount: 0n }), f.tx);
		expect(f.tx.generationJob.updateMany).not.toHaveBeenCalled();
	});

	it("rejects mismatched account ownership without financial writes or retry", async () => {
		const f = fixture();
		f.state.account.ownerId = "other-owner";
		await expect(f.store.settleForJob!(payload)).rejects.toThrow("GENERATION_FUNDING_CONFLICT");
		expect(f.database.$transaction).toHaveBeenCalledOnce();
		expect(funding.settle).not.toHaveBeenCalled();
	});

	it("preserves compatibility with stores that only implement claim and settle", async () => {
		const store = { claimSettlement: vi.fn(async () => oldClaim), settle: vi.fn(async () => {}) };
		expect(await settleGeneration(payload, { store })).toEqual({ outcome: "SETTLED" });
		expect(store.claimSettlement).toHaveBeenCalledExactlyOnceWith(payload);
		expect(store.settle).toHaveBeenCalledExactlyOnceWith(oldClaim);
	});
});
