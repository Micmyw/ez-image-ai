import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("#prisma-runtime-client", async () => {
	const { join } = await import("@prisma/client/runtime/client");
	return { Prisma: { join } };
});
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database");
	},
}));

import { CreditAdmissionPostgresFixture } from "../../../test-support/provider-admission-credit-port";
import {
	markMediaAssetDeletedTransaction,
	createGenerationOutputAssetBindingTransaction,
	claimGenerationOutputTransferTransaction,
} from "./assets";
import { createCreditGrant } from "./credits";
import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import { claimMediaStorageCleanupTransaction } from "./storage-cleanup";

// Real production admission/deletion/binding functions and pg transactions.
// This row port isolates the binding race; generated ORM and full migrations
// remain separate CI gates. Ledger decisions use the real credit functions.
const fixture = new CreditAdmissionPostgresFixture();
const checksum = "a".repeat(64);
const validUntil = new Date("2099-01-01");
beforeAll(async () => {
	await fixture.initialize();
	await fixture.rows(
		`ALTER TABLE ${fixture.table("generation_job_asset")} ADD COLUMN "assetChecksum" text, ADD COLUMN position integer`,
	);
	await fixture.rows(
		`CREATE TABLE ${fixture.table("media_asset")} (id text PRIMARY KEY,"ownerType" text,"ownerId" text,kind text,status text,"deletedAt" timestamptz,checksum text,"objectKey" text,"mimeType" text,"byteSize" bigint,"sourceUrl" text,"retentionClass" text NOT NULL DEFAULT 'ACCOUNT',"deleteAfter" timestamptz)`,
	);
	await fixture.rows(
		`ALTER TABLE ${fixture.table("generation_job_asset")} ADD FOREIGN KEY ("assetId") REFERENCES ${fixture.table("media_asset")}(id)`,
	);
});
beforeEach(async () => {
	await fixture.reset();
	await fixture.rows(`DELETE FROM ${fixture.table("media_asset")}`);
});
afterAll(() => fixture.close());

function gate() {
	let enter!: () => void, resume!: () => void;
	return {
		entered: new Promise<void>((resolve) => {
			enter = resolve;
		}),
		waiting: new Promise<void>((resolve) => {
			resume = resolve;
		}),
		enter: () => enter(),
		resume: () => resume(),
	};
}

type Hook = {
	beforeBinding?: ReturnType<typeof gate>;
	beforeDelete?: ReturnType<typeof gate>;
	afterQuote?: ReturnType<typeof gate>;
	pid?: (pid: number) => void;
	serializationConflict?: () => void;
};
function client(hook: Hook = {}) {
	return {
		$transaction: async (
			operation: (tx: unknown) => Promise<unknown>,
			options?: { isolationLevel: "ReadCommitted" | "Serializable" },
		) => {
			try {
				return await fixture.transaction(async (base, connection) => {
					if (hook.pid)
						hook.pid((await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
					return operation(port(base, connection, hook));
				}, options?.isolationLevel);
			} catch (error) {
				// Match the driver's originalCode transport without mocking SSI/retry.
				if (error && typeof error === "object" && "code" in error && error.code === "40001") {
					Object.assign(error, { cause: { originalCode: "40001" } });
					hook.serializationConflict?.();
				}
				throw error;
			}
		},
	};
}

function port(base: unknown, connection: PoolClient, hook: Hook) {
	const tx = base as Record<string, unknown>;
	const query = async (text: string, values: unknown[] = []) =>
		(await connection.query(text, values)).rows;
	const asset = async (id: string) => {
		const row = (await query(`SELECT * FROM ${fixture.table("media_asset")} WHERE id=$1`, [id]))[0];
		return row
			? {
					...row,
					byteSize: BigInt(row.byteSize),
					verificationGeneration: 1,
					verificationAttemptCount: 1,
					verificationProvider: "test",
					verificationProviderTaskId: null,
					verificationRuleVersion: "asset-rule",
					verificationPolicyVersion: "asset-policy",
					verificationValidUntil: validUntil,
					retentionClass: row.retentionClass,
					deleteAfter: row.deleteAfter,
					uploadSessions: [],
				}
			: null;
	};
	return {
		...tx,
		generationQuote: {
			...(tx.generationQuote as object),
			findUnique: async (args: unknown) => {
				const quote = await (
					tx.generationQuote as {
						findUnique: (args: unknown) => Promise<unknown>;
					}
				).findUnique(args);
				hook.afterQuote?.enter();
				if (hook.afterQuote) await hook.afterQuote.waiting;
				return quote;
			},
		},
		mediaAsset: {
			findUnique: ({ where }: { where: { id: string } }) => asset(where.id),
			findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
				const found = await asset(where.id);
				if (!found) throw new Error("ASSET_NOT_FOUND");
				return found;
			},
			findFirst: async ({ where }: { where: { id: string; ownerId: string } }) => {
				const row = await asset(where.id);
				return row &&
					row.ownerId === where.ownerId &&
					row.deletedAt === null &&
					row.status !== "UPLOADING"
					? row
					: null;
			},
			findMany: async ({ where }: { where: { id: { in: string[] }; ownerId: string } }) => {
				const rows = await Promise.all(where.id.in.map(asset));
				return rows.filter(
					(row) =>
						row &&
						row.ownerId === where.ownerId &&
						row.status === "READY" &&
						row.deletedAt === null &&
						row.checksum !== null,
				);
			},
			update: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: { status: string; deletedAt: Date };
			}) => {
				hook.beforeDelete?.enter();
				if (hook.beforeDelete) await hook.beforeDelete.waiting;
				return (
					await query(
						`UPDATE ${fixture.table("media_asset")} SET status=$2,"deletedAt"=$3 WHERE id=$1 RETURNING *`,
						[where.id, data.status, data.deletedAt],
					)
				)[0];
			},
		},
		assetModerationResult: {
			findMany: async ({ where }: { where: { OR: Array<{ assetId: string }> } }) =>
				where.OR.map(({ assetId }) => ({
					assetId,
					assetChecksum: checksum,
					verificationGeneration: 1,
					attemptNumber: 1,
					evidenceKind: "INPUT",
					provider: "test",
					providerTaskId: null,
					ruleVersion: "asset-rule",
					policyVersion: "asset-policy",
					status: "APPROVED",
					validUntil,
				})),
		},
		generationJob: {
			...(tx.generationJob as object),
			findFirst: async ({ where }: { where: { id: string; ownerId: string; status: string } }) =>
				(
					await query(
						`SELECT * FROM ${fixture.table("generation_job")} WHERE id=$1 AND "ownerId"=$2 AND status=$3`,
						[where.id, where.ownerId, where.status],
					)
				)[0] ?? null,
		},
		generationJobAsset: {
			...(tx.generationJobAsset as object),
			findFirst: async ({
				where,
			}: {
				where: { assetId: string; job: { status: { in: string[] } } };
			}) =>
				(
					await query(
						`SELECT b."jobId" FROM ${fixture.table("generation_job_asset")} b JOIN ${fixture.table("generation_job")} j ON j.id=b."jobId" WHERE b."assetId"=$1 AND j.status=ANY($2::text[]) LIMIT 1`,
						[where.assetId, where.job.status.in],
					)
				)[0] ?? null,
			createMany: async ({
				data,
			}: {
				data: Array<{
					jobId: string;
					assetId: string;
					assetChecksum: string;
					role: string;
					position: number;
				}>;
			}) => {
				hook.beforeBinding?.enter();
				if (hook.beforeBinding) await hook.beforeBinding.waiting;
				for (const row of data)
					await query(
						`INSERT INTO ${fixture.table("generation_job_asset")} ("jobId","assetId","assetChecksum",role,position) VALUES ($1,$2,$3,$4,$5)`,
						[row.jobId, row.assetId, row.assetChecksum, row.role, row.position],
					);
				return { count: data.length };
			},
			upsert: async ({
				create,
			}: {
				create: {
					jobId: string;
					assetId: string;
					assetChecksum: string;
					role: string;
					position: number;
				};
			}) => {
				await query(
					`INSERT INTO ${fixture.table("generation_job_asset")} ("jobId","assetId","assetChecksum",role,position) VALUES ($1,$2,$3,$4,$5)`,
					[create.jobId, create.assetId, create.assetChecksum, create.role, create.position],
				);
				return create;
			},
		},
		mediaUploadSession: { findFirst: async () => null },
		auditLog: { create: async () => ({}) },
	};
}

async function seed() {
	await fixture.transaction(async (tx) => {
		await tx.creditAccount.create({
			data: { id: "owner", ownerType: "USER", ownerId: "owner" },
		} as never);
		await createCreditGrant({ accountId: "owner", amount: 20n, referenceKey: "fund" }, tx);
		const quote = {
			id: "quote",
			ownerType: "USER" as const,
			ownerId: "owner",
			submittedByUserId: "owner",
			productKey: "image-fast",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 5n,
			costMicros: 0n,
			inputSnapshot: { kind: "image-to-image", sourceAssetId: "asset", prompt: "reviewed" },
			pricingSnapshot: {},
			expiresAt: validUntil,
			moderationDecision: "ALLOW",
			moderationProvider: "test",
			moderationRuleVersion: "rule",
			moderationReasonCode: "ALLOW",
		};
		await tx.generationQuote.create({
			data: { ...quote, inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote) },
		} as never);
	});
	await fixture.rows(
		`INSERT INTO ${fixture.table("media_asset")} (id,"ownerType","ownerId",kind,status,"deletedAt",checksum,"objectKey","mimeType","byteSize","sourceUrl") VALUES ('asset','USER','owner','INPUT','READY',NULL,$1,'users/owner/input.png','image/png',10,NULL)`,
		[checksum],
	);
	return {
		ownerType: "USER" as const,
		ownerId: "owner",
		submittedByUserId: "owner",
		quoteId: "quote",
		idempotencyKey: "request",
		inputAssetIds: ["asset"],
		expectedModerationRuleVersion: "rule",
		expectedAssetModerationRuleVersion: "asset-rule",
		expectedAssetModerationPolicyVersion: "asset-policy",
	};
}

async function waitForLock(pid: number) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const rows = await fixture.rows(
			`SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted`,
			[pid],
		);
		if (rows.length) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("ADVISORY_LOCK_WAIT_NOT_OBSERVED");
}

describe("input bindings and deletion preserve the original SSI protocol", () => {
	it("rejects a stale input admission after guest cleanup wins the binding fence", async () => {
		const input = await seed();
		await fixture.rows(
			`UPDATE ${fixture.table("media_asset")} SET "retentionClass"='GUEST_TRIAL',"deleteAfter"=clock_timestamp()+interval '200 milliseconds' WHERE id='asset'`,
		);
		const snapshot = gate();
		const cleanup = gate();
		let creatingPid = 0;
		let serializationConflicts = 0;
		const creating = createGenerationJobTransaction(
			input,
			client({
				afterQuote: snapshot,
				pid: (pid) => (creatingPid ||= pid),
				serializationConflict: () => serializationConflicts++,
			}) as never,
		);
		await snapshot.entered;
		// Establish the admission's snapshot before the real deadline, then let the
		// actual cleanup consumer own the advisory and row locks before resuming it.
		for (let attempt = 0; ; attempt++) {
			const [clock] = await fixture.rows(
				`SELECT clock_timestamp() >= "deleteAfter" AS expired FROM ${fixture.table("media_asset")} WHERE id='asset'`,
			);
			if (clock?.expired) break;
			if (attempt >= 400) throw new Error("ASSET_EXPIRY_NOT_OBSERVED");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const deleting = claimMediaStorageCleanupTransaction(
			{ assetId: "asset", objectKeys: ["users/owner/input.png"] },
			client({ beforeDelete: cleanup }) as never,
		);
		await cleanup.entered;
		snapshot.resume();
		try {
			await waitForLock(creatingPid);
		} finally {
			cleanup.resume();
		}
		const [deleted, created] = await Promise.allSettled([deleting, creating]);
		expect(deleted).toMatchObject({ status: "fulfilled", value: "DELETE" });
		expect(created).toMatchObject({
			status: "rejected",
			reason: { message: "Every input asset must be READY and owned by the user" },
		});
		// The production FK's check observes a changed asset tuple and forces a
		// real 40001 retry. Without that FK, advisory locks alone permit stale reads.
		expect(serializationConflicts).toBeGreaterThan(0);
		expect(
			await fixture.rows(`SELECT * FROM ${fixture.table("generation_job_asset")}`),
		).toHaveLength(0);
		expect(await fixture.rows(`SELECT id FROM ${fixture.table("generation_job")}`)).toHaveLength(0);
		expect(
			await fixture.rows(`SELECT id FROM ${fixture.table("credit_reservation")}`),
		).toHaveLength(0);
		expect(
			(
				await fixture.rows(
					`SELECT "spendableCredits","reservedCredits" FROM ${fixture.table("credit_account")} WHERE id='owner'`,
				)
			)[0],
		).toMatchObject({ spendableCredits: 20n, reservedCredits: 0n });
	});

	it("keeps a text winner and a queued asset admission within the same global cost budget", async () => {
		const input = await seed();
		const quoted = await fixture
			.client()
			.generationQuote.findUniqueOrThrow({ where: { id: "quote" } });
		const assetQuote = { ...quoted, costMicros: 60n };
		await fixture.rows(
			`UPDATE ${fixture.table("generation_quote")} SET "costMicros"=$1,"inputFingerprint"=$2 WHERE id='quote'`,
			[assetQuote.costMicros, fingerprintGenerationQuoteSecurityPayload(assetQuote)],
		);
		await fixture.transaction(async (tx) => {
			await tx.creditAccount.create({
				data: { id: "text-owner", ownerType: "USER", ownerId: "text-owner" },
			} as never);
			await createCreditGrant(
				{ accountId: "text-owner", amount: 20n, referenceKey: "text-fund" },
				tx,
			);
			const textQuote = {
				...assetQuote,
				id: "text-quote",
				ownerId: "text-owner",
				submittedByUserId: "text-owner",
				inputSnapshot: { kind: "text-to-image", prompt: "reviewed" },
			};
			await tx.generationQuote.create({
				data: {
					...textQuote,
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(textQuote),
				},
			} as never);
		});
		const barrier = gate();
		const assetAdmission = createGenerationJobTransaction(
			{ ...input, maximumGlobalDailyCostMicros: 100n },
			client({ afterQuote: barrier }) as never,
		);
		// The asset transaction has a snapshot before the other owner's text job
		// commits. The actual selector must keep both budget writers on SSI so its
		// first stale attempt aborts, then its retry sees the winning cost.
		await barrier.entered;
		try {
			const text = await createGenerationJobTransaction(
				{
					...input,
					ownerId: "text-owner",
					submittedByUserId: "text-owner",
					quoteId: "text-quote",
					inputAssetIds: [],
					maximumGlobalDailyCostMicros: 100n,
				},
				client() as never,
			);
			expect(text.replayed).toBe(false);
		} finally {
			barrier.resume();
		}
		await expect(assetAdmission).rejects.toThrow("GLOBAL_DAILY_BUDGET_EXCEEDED");
		expect(
			(
				await fixture.rows(
					`SELECT COALESCE(SUM(q."costMicros"),0)::text AS total FROM ${fixture.table("generation_job")} j JOIN ${fixture.table("generation_quote")} q ON q.id=j."quoteId"`,
				)
			)[0]?.total,
		).toBe(60n);
		expect(await fixture.rows(`SELECT id FROM ${fixture.table("generation_job")}`)).toHaveLength(1);
		expect(
			await fixture.rows(`SELECT id FROM ${fixture.table("credit_reservation")}`),
		).toHaveLength(1);
		expect(await fixture.rows(`SELECT id FROM ${fixture.table("outbox_event")}`)).toHaveLength(1);
		expect(
			await fixture.rows(`SELECT * FROM ${fixture.table("generation_job_asset")}`),
		).toHaveLength(0);
		expect(
			(
				await fixture.rows(
					`SELECT "spendableCredits","reservedCredits" FROM ${fixture.table("credit_account")} WHERE id='owner'`,
				)
			)[0],
		).toMatchObject({ spendableCredits: 20n, reservedCredits: 0n });
	});

	it.each([0n, -1n])(
		"rejects the invalid global budget %s without job or reservation writes",
		async (maximumGlobalDailyCostMicros) => {
			const input = await seed();
			await expect(
				createGenerationJobTransaction(
					{ ...input, inputAssetIds: [], maximumGlobalDailyCostMicros },
					client() as never,
				),
			).rejects.toThrow("Global daily Provider budget must be positive");
			expect(await fixture.rows(`SELECT id FROM ${fixture.table("generation_job")}`)).toHaveLength(
				0,
			);
			expect(
				await fixture.rows(`SELECT id FROM ${fixture.table("credit_reservation")}`),
			).toHaveLength(0);
		},
	);

	it("rejects deletion when input admission wins the binding fence", async () => {
		const input = await seed();
		const barrier = gate();
		let deletingPid = 0;
		const creating = createGenerationJobTransaction(
			input,
			client({ beforeBinding: barrier }) as never,
		);
		await barrier.entered;
		const deleting = markMediaAssetDeletedTransaction(
			{ assetId: "asset", ownerId: "owner" },
			client({
				pid: (pid) => {
					deletingPid ||= pid;
				},
			}) as never,
		);
		try {
			while (!deletingPid) await new Promise((resolve) => setTimeout(resolve, 1));
			await waitForLock(deletingPid);
		} finally {
			barrier.resume();
		}
		const [created, deleted] = await Promise.allSettled([creating, deleting]);
		expect(created.status).toBe("fulfilled");
		expect(deleted).toMatchObject({
			status: "rejected",
			reason: { message: "MEDIA_ASSET_BOUND_TO_ACTIVE_GENERATION_JOB" },
		});
		expect(
			(await fixture.rows(`SELECT status FROM ${fixture.table("media_asset")} WHERE id='asset'`))[0]
				?.status,
		).toBe("READY");
	});

	it("rejects a new input binding when deletion wins the fence", async () => {
		const input = await seed();
		const barrier = gate();
		let creatingPid = 0;
		const deleting = markMediaAssetDeletedTransaction(
			{ assetId: "asset", ownerId: "owner" },
			client({ beforeDelete: barrier }) as never,
		);
		await barrier.entered;
		const creating = createGenerationJobTransaction(
			input,
			client({
				pid: (pid) => {
					creatingPid ||= pid;
				},
			}) as never,
		);
		try {
			while (!creatingPid) await new Promise((resolve) => setTimeout(resolve, 1));
			await waitForLock(creatingPid);
		} finally {
			barrier.resume();
		}
		const [deleted, created] = await Promise.allSettled([deleting, creating]);
		expect(deleted.status).toBe("fulfilled");
		expect(created).toMatchObject({
			status: "rejected",
			reason: { message: "Every input asset must be READY and owned by the user" },
		});
		expect(
			await fixture.rows(`SELECT * FROM ${fixture.table("generation_job_asset")}`),
		).toHaveLength(0);
	});

	it.each(["binding", "transfer"] as const)(
		"keeps existing output %s fenced against a concurrent deletion",
		async (operation) => {
			const input = await seed();
			await fixture.rows(
				`UPDATE ${fixture.table("generation_quote")} SET "inputSnapshot"=$1 WHERE id='quote'`,
				[{ kind: "text-to-image", prompt: "reviewed" }],
			);
			// Seed an already accepted finalizing job; this test calls the real output
			// binding transaction and does not alter its isolation or write contract.
			await fixture.rows(
				`INSERT INTO ${fixture.table("generation_job")} (id,"ownerType","ownerId","submittedByUserId","quoteId","idempotencyKey","productKey","catalogVersion","pricingVersion","creditsReserved","inputSnapshot","pricingSnapshot",status) VALUES ('output-job','USER','owner','owner','quote','output','image-fast','test','test',5,'{}','{}','FINALIZING')`,
			);
			await fixture.rows(
				`UPDATE ${fixture.table("media_asset")} SET kind='OUTPUT',"sourceUrl"='provider-output:test' WHERE id='asset'`,
			);
			const barrier = gate();
			let bindingPid = 0;
			const deleting = markMediaAssetDeletedTransaction(
				{ assetId: "asset", ownerId: "owner" },
				client({ beforeDelete: barrier }) as never,
			);
			await barrier.entered;
			const connection = client({
				pid: (pid) => {
					bindingPid ||= pid;
				},
			});
			const binding =
				operation === "binding"
					? createGenerationOutputAssetBindingTransaction(
							{
								jobId: "output-job",
								asset: {
									id: "asset",
									ownerId: input.ownerId,
									objectKey: "users/owner/input.png",
									mimeType: "image/png",
									byteSize: 10n,
									checksum,
									sourceUrl: "provider-output:test",
								},
							},
							connection as never,
						)
					: claimGenerationOutputTransferTransaction(
							{
								jobId: "output-job",
								ownerId: input.ownerId,
								assetId: "asset",
								objectKey: "users/owner/input.png",
								mimeType: "image/png",
								sourceUrl: "provider-output:test",
								createStagingObjectKey: (token) => `users/owner/staging/${token}`,
							},
							connection as never,
						);
			try {
				while (!bindingPid) await new Promise((resolve) => setTimeout(resolve, 1));
				await waitForLock(bindingPid);
			} finally {
				barrier.resume();
			}
			const [deleted, bound] = await Promise.allSettled([deleting, binding]);
			expect(deleted.status).toBe("fulfilled");
			expect(bound).toMatchObject({
				status: "rejected",
				reason: { message: "GENERATION_OUTPUT_ASSET_DELETED" },
			});
		},
	);
});
