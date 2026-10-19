import { randomUUID } from "node:crypto";

import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const implicitClient = vi.hoisted(() => ({ current: null as unknown }));

// Only substitute the unavailable generated module's SQL-builder export. No
// PrismaClient or ledger decision is mocked; every row operation reaches pg.
vi.mock("#prisma-runtime-client", async () => {
	const { join } = await import("@prisma/client/runtime/client");
	return { Prisma: { join } };
});
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		if (implicitClient.current) return implicitClient.current;
		throw new Error("Unexpected implicit database connection");
	},
}));

import { CreditAdmissionPostgresFixture } from "../../../test-support/provider-admission-credit-port";
import type { Prisma } from "../../generated/client";
import {
	createCreditGrant,
	releaseCreditsInTransaction,
	reserveCreditsInTransaction,
	settleCreditsInTransaction,
} from "./credits";
import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import type { MediaTransactionClient } from "./types";
import { claimVideoProviderSubmission } from "./video-v1-execution";

const fixture = new CreditAdmissionPostgresFixture();
const simulatedProviderPosts: string[] = [];
beforeAll(async () => {
	await fixture.initialize();
	await initializeNativeDispatchTables();
});
beforeEach(async () => {
	implicitClient.current = null;
	await fixture.reset();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => fixture.close());

// This covers the real admission and ledger functions over a PostgreSQL row
// port. Provider HTTP, generated ORM mappings, and full lifecycle callers are
// separate checks; an outbox assertion establishes one durable intent only.
describe("funded admission retains atomic credit accounting", () => {
	it("accepts 32 unfinished jobs for one funded owner despite the retired one-job quota", async () => {
		await fund("owner", 160n);
		const results = [];
		for (let index = 0; index < 32; index += 1) {
			results.push(await submit(await quote("owner", `request-${index}`)));
		}
		expect(new Set(results.map(({ job }) => job.id)).size).toBe(32);
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 160n,
			creditDebt: 0n,
		});
		expect(await counts()).toEqual({ jobs: 32, reserves: 32, outbox: 32 });
	});

	it("accepts 32 simultaneous funded submissions from the same owner", async () => {
		await fund("owner", 160n);
		const inputs = await Promise.all(
			Array.from({ length: 32 }, (_, index) => quote("owner", `parallel-${index}`)),
		);
		const accepted = await Promise.all(inputs.map(submit));
		expect(new Set(accepted.map(({ job }) => job.id)).size).toBe(32);
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 160n,
			creditDebt: 0n,
		});
		expect(await counts()).toEqual({ jobs: 32, reserves: 32, outbox: 32 });
	});

	it("admits 32 independently funded owners without borrowing another owner's balance or task slots", async () => {
		const owners = Array.from({ length: 32 }, (_, index) => `owner-${index}`);
		await Promise.all(owners.map((owner) => fund(owner, 5n)));
		const inputs = await Promise.all(owners.map((owner) => quote(owner, "first")));
		const accepted = await Promise.all(inputs.map(submit));
		expect(new Set(accepted.map(({ job }) => job.id)).size).toBe(32);
		for (const owner of owners) {
			expect(await balance(owner)).toMatchObject({
				spendableCredits: 0n,
				reservedCredits: 5n,
				creditDebt: 0n,
			});
		}
		expect(await counts()).toEqual({ jobs: 32, reserves: 32, outbox: 32 });
	});

	it("rolls back losing simultaneous submissions instead of overspending the same owner's balance", async () => {
		await fund("owner", 10n);
		const inputs = await Promise.all(
			Array.from({ length: 8 }, (_, index) => quote("owner", `race-${index}`)),
		);
		const results = await Promise.allSettled(inputs.map(submit));
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
		for (const result of results) {
			if (result.status === "rejected")
				expect(result.reason).toMatchObject({ message: "INSUFFICIENT_CREDITS" });
		}
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 10n,
			creditDebt: 0n,
		});
		expect(await counts()).toEqual({ jobs: 2, reserves: 2, outbox: 2 });
		const lots = await fixture.rows(
			`SELECT "remainingAmount", "reservedAmount" FROM ${fixture.table("credit_lot")}`,
		);
		expect(lots).toEqual([{ remainingAmount: 0n, reservedAmount: 10n }]);
	});

	it("commits one job, reservation, allocation and durable intent for simultaneous idempotent retries", async () => {
		await fund("owner", 10n);
		const input = await quote("owner", "same-request");
		const results = await Promise.all(Array.from({ length: 12 }, () => submit(input)));
		expect(new Set(results.map(({ job }) => job.id)).size).toBe(1);
		expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
		expect(await counts()).toEqual({ jobs: 1, reserves: 1, outbox: 1 });
		expect(
			(
				await fixture.rows(
					`SELECT count(*)::int AS count FROM ${fixture.table("credit_reservation_allocation")}`,
				)
			)[0]?.count,
		).toBe(1);
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 5n,
			reservedCredits: 5n,
			creditDebt: 0n,
		});
	});

	it("refuses an unapproved quote before creating any job or reservation", async () => {
		await fund("owner", 5n);
		const input = await quote("owner", "unsafe", "REJECT");
		await expect(submit(input)).rejects.toThrow("TEXT_MODERATION_EVIDENCE_INVALID");
		expect(await counts()).toEqual({ jobs: 0, reserves: 0, outbox: 0 });
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 5n,
			reservedCredits: 0n,
			creditDebt: 0n,
		});
	});

	it.each(["SAFETY_FAILED", "CANCELED"])(
		"releases a %s caller's reservation once and restores its original lot",
		async (reason) => {
			await fund("owner", 5n);
			const created = await submit(await quote("owner", "accepted"));
			const release = () =>
				fixture.transaction(async (tx, connection) => {
					await connection.query(
						`UPDATE ${fixture.table("generation_job")} SET status=$1 WHERE id=$2`,
						[reason === "CANCELED" ? "CANCELED" : "FAILED", created.job.id],
					);
					return releaseCreditsInTransaction(
						{
							reservationId: created.reservation.id,
							referenceKey: `job:${created.job.id}:${reason}`,
						},
						tx,
					);
				});
			await release();
			await release();
			expect(await balance("owner")).toMatchObject({
				spendableCredits: 5n,
				reservedCredits: 0n,
				creditDebt: 0n,
			});
			const rows = await fixture.rows(
				`SELECT type, amount FROM ${fixture.table("credit_ledger_entry")} WHERE "reservationId"=$1 ORDER BY type`,
				[created.reservation.id],
			);
			expect(rows).toEqual([
				{ type: "RELEASE", amount: 5n },
				{ type: "RESERVE", amount: 5n },
			]);
			expect(
				await fixture.rows(
					`SELECT "remainingAmount", "reservedAmount" FROM ${fixture.table("credit_lot")}`,
				),
			).toEqual([{ remainingAmount: 5n, reservedAmount: 0n }]);
		},
	);

	it("replays an uncertain accepted job without a second reserve or durable provider intent", async () => {
		await fund("owner", 10n);
		const input = await quote("owner", "unknown-response");
		const accepted = await submit(input);
		await fixture.rows(
			`UPDATE ${fixture.table("generation_job")} SET status='NEEDS_RECONCILIATION' WHERE id=$1 RETURNING id`,
			[accepted.job.id],
		);
		const replay = await submit(input);
		expect(replay).toMatchObject({
			replayed: true,
			job: { id: accepted.job.id, status: "NEEDS_RECONCILIATION" },
		});
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 5n,
			reservedCredits: 5n,
			creditDebt: 0n,
		});
		expect(await counts()).toEqual({ jobs: 1, reserves: 1, outbox: 1 });
		expect(
			await fixture.rows(`SELECT status FROM ${fixture.table("credit_reservation")} WHERE id=$1`, [
				accepted.reservation.id,
			]),
		).toEqual([{ status: "ACTIVE" }]);
	});
});

// The accepted native context is seeded after the ordinary admission coverage
// above. Funding, account locks, send claims, fences and settlement are the real
// production functions over pg. This is not native API admission, generated ORM,
// provider HTTP, output moderation or complete successful-job lifecycle coverage.
describe("funded sends ignore an unverified project concurrency value", () => {
	beforeEach(() => {
		vi.stubEnv("VIDEO_V1_PROVIDER_CONCURRENCY", "2");
		implicitClient.current = nativeDispatchClient();
		simulatedProviderPosts.length = 0;
	});

	it("claims all four funded owners in parallel while all earlier provider outcomes remain unknown", async () => {
		const owners = Array.from({ length: 4 }, (_, index) => `dispatch-owner-${index}`);
		for (const owner of owners) await fund(owner, 5n);
		const accepted = await Promise.all(owners.map((owner) => acceptNativeContext(owner, "first")));
		const results = await Promise.all(accepted.map(({ jobId }) => claimAndSimulateSubmit(jobId)));

		// No earlier request completes to free a slot: all four send fences must
		// coexist even though the retired project setting is exactly two.
		expect(results.map(({ claimed }) => claimed)).toEqual([true, true, true, true]);
		expect(new Set(results.map(({ attemptId }) => attemptId)).size).toBe(4);
		expect(simulatedProviderPosts).toHaveLength(4);
		expect(new Set(simulatedProviderPosts).size).toBe(4);
		expect(await attemptState()).toEqual({ attempts: 4, uncertain: 4 });
		for (const owner of owners) {
			expect(await balance(owner)).toMatchObject({
				spendableCredits: 0n,
				reservedCredits: 5n,
				creditDebt: 0n,
			});
		}
		expect(await ledgerState()).toEqual({ reserves: 4, settles: 0, reserved: 20n, settled: 0n });
		const unknownReplays = await Promise.all(
			accepted.map(({ jobId }) => claimAndSimulateSubmit(jobId)),
		);
		expect(unknownReplays.every(({ claimed }) => !claimed)).toBe(true);
		expect(simulatedProviderPosts).toHaveLength(4);
		expect(await attemptState()).toEqual({ attempts: 4, uncertain: 4 });
		expect(await ledgerState()).toEqual({ reserves: 4, settles: 0, reserved: 20n, settled: 0n });

		// Supply the caller's confirmed success for each distinct account. This
		// does not exercise provider retrieval or output moderation decisions.
		await fixture.rows(
			`UPDATE ${fixture.table("generation_attempt")} SET status='SUCCEEDED', "uncertainSubmission"=false, "completedAt"=now() RETURNING id`,
		);
		await Promise.all(accepted.map(settleNative));
		await Promise.all(accepted.map(settleNative));
		expect(await ledgerState()).toEqual({ reserves: 4, settles: 4, reserved: 20n, settled: 20n });
		for (const owner of owners) {
			expect(await balance(owner)).toMatchObject({
				spendableCredits: 0n,
				reservedCredits: 0n,
				creditDebt: 0n,
			});
		}
	});

	it("lets one duplicate claimant cross the simulated submit boundary and holds an unknown outcome", async () => {
		await fund("duplicate-owner", 10n);
		const accepted = await acceptNativeContext("duplicate-owner", "same-job");
		const results = await Promise.all(
			Array.from({ length: 12 }, () => claimAndSimulateSubmit(accepted.jobId)),
		);
		expect(results.filter(({ claimed }) => claimed)).toHaveLength(1);
		expect(new Set(results.map(({ attemptId }) => attemptId)).size).toBe(1);
		const replays = await Promise.all(
			Array.from({ length: 4 }, () => claimAndSimulateSubmit(accepted.jobId)),
		);
		expect(replays.every(({ claimed }) => !claimed)).toBe(true);
		expect(simulatedProviderPosts).toEqual([results[0]!.attemptId]);
		expect(await attemptState()).toEqual({ attempts: 1, uncertain: 1 });
		expect(await ledgerState()).toEqual({ reserves: 1, settles: 0, reserved: 5n, settled: 0n });
		expect(await balance("duplicate-owner")).toMatchObject({
			spendableCredits: 5n,
			reservedCredits: 5n,
			creditDebt: 0n,
		});
	});

	it("settles a known successful submission once when its completion is replayed", async () => {
		await fund("settled-owner", 10n);
		const accepted = await acceptNativeContext("settled-owner", "success");
		expect(await claimAndSimulateSubmit(accepted.jobId)).toMatchObject({ claimed: true });
		// This supplies a confirmed terminal caller decision, not provider evidence
		// validation. The ledger itself must still enforce one settlement.
		await fixture.rows(
			`UPDATE ${fixture.table("generation_attempt")} SET status='SUCCEEDED', "uncertainSubmission"=false, "completedAt"=now() WHERE "jobId"=$1 RETURNING id`,
			[accepted.jobId],
		);
		await settleNative(accepted);
		await settleNative(accepted);
		expect(await claimAndSimulateSubmit(accepted.jobId)).toMatchObject({ claimed: false });
		expect(simulatedProviderPosts).toHaveLength(1);
		expect(await attemptState()).toEqual({ attempts: 1, uncertain: 0 });
		expect(await ledgerState()).toEqual({ reserves: 1, settles: 1, reserved: 5n, settled: 5n });
		expect(await balance("settled-owner")).toMatchObject({
			spendableCredits: 5n,
			reservedCredits: 0n,
			creditDebt: 0n,
		});
	});

	it("still refuses reservations beyond the real balance when the old dispatch setting is two", async () => {
		await fund("limited-owner", 10n);
		const results = await Promise.allSettled(
			Array.from({ length: 6 }, (_, index) =>
				acceptNativeContext("limited-owner", `limited-${index}`),
			),
		);
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
		for (const result of results) {
			if (result.status === "rejected")
				expect(result.reason).toMatchObject({ message: "INSUFFICIENT_CREDITS" });
		}
		expect(await ledgerState()).toEqual({ reserves: 2, settles: 0, reserved: 10n, settled: 0n });
		expect(await balance("limited-owner")).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 10n,
			creditDebt: 0n,
		});
		expect(
			(
				await fixture.rows(`SELECT count(*)::int AS count FROM ${fixture.table("generation_job")}`)
			)[0]?.count,
		).toBe(2);
		expect(await attemptState()).toEqual({ attempts: 0, uncertain: 0 });
		expect(simulatedProviderPosts).toEqual([]);
	});
});

async function initializeNativeDispatchTables() {
	const statements = `ALTER TABLE ${fixture.table("generation_job")} ADD COLUMN "terminalAt" timestamptz;
		CREATE TABLE ${fixture.table("generation_attempt")} (
			id text PRIMARY KEY, "jobId" text NOT NULL REFERENCES ${fixture.table("generation_job")}(id),
			"attemptNumber" integer NOT NULL, provider text NOT NULL, "providerModelId" text NOT NULL,
			"callbackTokenHash" text, "requestSnapshot" jsonb, status text NOT NULL,
			"uncertainSubmission" boolean NOT NULL, "submittedAt" timestamptz, "providerTaskId" text,
			"completedAt" timestamptz, "responseSnapshot" jsonb, UNIQUE ("jobId","attemptNumber")
		);
		CREATE TABLE ${fixture.table("video_execution")} (
			"jobId" text PRIMARY KEY REFERENCES ${fixture.table("generation_job")}(id), stage text NOT NULL,
			"stageData" jsonb NOT NULL, "stateVersion" integer NOT NULL DEFAULT 0,
			"lastProgressAt" timestamptz, "providerSubmitStartedAt" timestamptz
		);
		CREATE TABLE ${fixture.table("video_template_execution")} (
			"submittedAt" timestamptz, "acceptedAt" timestamptz, "sceneSubmissionUncertain" boolean,
			"sceneProviderTaskId" text, "sceneState" text, "sceneProviderEvidence" jsonb
		)`;
	for (const statement of statements.split(";").filter((part) => part.trim())) {
		await fixture.rows(statement);
	}
}

async function acceptNativeContext(ownerId: string, key: string) {
	const jobId = `${ownerId}:${key}`;
	const profile = createVideoTextSafetyProfile();
	const inputSnapshot = {
		mode: "text-to-video",
		prompt: "Reviewed fixture",
		requestFingerprint: "f".repeat(64),
		textSafetyProfile: profile,
		outputStoragePolicy: { schemaVersion: 1, maximumBytes: 1 },
	};
	return fixture.transaction(async (tx, connection) => {
		const record = {
			id: `quote:${jobId}`,
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			productKey: "native-video-test",
			catalogVersion: "test-catalog",
			pricingVersion: "test-pricing",
			credits: 5n,
			costMicros: 1n,
			inputSnapshot,
			pricingSnapshot: {},
			expiresAt: new Date("2099-01-01"),
			moderationDecision: "ALLOW",
			moderationProvider: "test",
			moderationRuleVersion: "fixture-policy",
			moderationReasonCode: "ALLOW",
		};
		await tx.generationQuote.create({
			data: { ...record, inputFingerprint: fingerprintGenerationQuoteSecurityPayload(record) },
		} as never);
		await tx.generationJob.create({
			data: {
				id: jobId,
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: record.id,
				idempotencyKey: key,
				productKey: record.productKey,
				catalogVersion: record.catalogVersion,
				pricingVersion: record.pricingVersion,
				creditsReserved: 5n,
				inputSnapshot,
				pricingSnapshot: {},
				status: "DISPATCH_QUEUED",
				executionEngine: "video-workflow-v1",
			},
		} as never);
		const reservation = await reserveCreditsInTransaction(
			{ accountId: ownerId, jobId, amount: 5n, referenceKey: `reserve:${jobId}` },
			tx,
		);
		const requestId = randomUUID();
		const textDecision = {
			decision: "ALLOW",
			reasonCode: "WAFFO_PROMPT_ALLOWED",
			ruleVersion: profile.ruleVersion,
			evidence: {
				requestId,
				models: ["waffo-prompt-sift"],
				operations: 1,
				waffo: { requestId, action: "allow", semanticStatus: "scored", matchedCategories: [] },
			},
		};
		await connection.query(
			`INSERT INTO ${fixture.table("video_execution")} ("jobId",stage,"stageData") VALUES ($1,'INPUT_REVIEW',$2)`,
			[
				jobId,
				{
					inputReview: {
						status: "ALLOW",
						ruleVersion: "fixture-policy",
						requestFingerprint: inputSnapshot.requestFingerprint,
						textSafetyProfile: profile,
						textDecision,
						validUntil: "2099-01-01T00:00:00.000Z",
					},
				},
			],
		);
		await connection.query(
			`INSERT INTO ${fixture.table("storage_usage_reservation")} (id,"ownerType","ownerId",bytes,status,"referenceKey","expiresAt") VALUES ($1,'USER',$2,1,'ACTIVE',$3,'2099-01-01')`,
			[`storage:${jobId}`, ownerId, `video-output:${jobId}`],
		);
		return { jobId, reservationId: reservation.id };
	});
}

function nativeDispatchClient(): MediaTransactionClient {
	return {
		$transaction: <T>(
			operation: (tx: Prisma.TransactionClient) => Promise<T>,
			options: { isolationLevel: "ReadCommitted" | "Serializable" },
		) =>
			fixture.transaction(
				(tx, connection) => operation(nativeDispatchPort(tx, connection)),
				options.isolationLevel,
			),
	} as unknown as MediaTransactionClient;
}

function nativeDispatchPort(
	tx: Prisma.TransactionClient,
	connection: PoolClient,
): Prisma.TransactionClient {
	const updateVideo = async ({
		where,
		data,
	}: {
		where: { jobId: string };
		data: Record<string, unknown>;
	}) => {
		const values: unknown[] = [];
		const assignments = Object.entries(data).map(([key, value]) => {
			const increment =
				value && typeof value === "object" && "increment" in value ? value.increment : undefined;
			values.push(increment ?? value);
			return `"${key}"=${increment === undefined ? "" : `"${key}"+`}$${values.length}`;
		});
		values.push(where.jobId);
		return (
			await connection.query(
				`UPDATE ${fixture.table("video_execution")} SET ${assignments.join(",")} WHERE "jobId"=$${values.length} RETURNING *`,
				values,
			)
		).rows[0];
	};
	return {
		...tx,
		generationJob: {
			...tx.generationJob,
			findFirst: async (args: { where: { id: string }; include?: unknown }) => {
				const job = await tx.generationJob.findFirst(args as never);
				if (!job || !args.include) return job;
				return {
					...job,
					assets: [],
					videoTemplateExecution: null,
					videoExecution: (
						await connection.query(
							`SELECT * FROM ${fixture.table("video_execution")} WHERE "jobId"=$1`,
							[job.id],
						)
					).rows[0],
					attempts: (
						await connection.query(
							`SELECT * FROM ${fixture.table("generation_attempt")} WHERE "jobId"=$1 ORDER BY "attemptNumber" DESC`,
							[job.id],
						)
					).rows,
				};
			},
		},
		storageUsageReservation: {
			...tx.storageUsageReservation,
			findFirst: async ({
				where,
			}: {
				where: {
					ownerType: string;
					ownerId: string;
					referenceKey: string;
					status: string;
					bytes: { gte: bigint };
				};
			}) =>
				(
					await connection.query(
						`SELECT id FROM ${fixture.table("storage_usage_reservation")} WHERE "ownerType"=$1 AND "ownerId"=$2 AND "referenceKey"=$3 AND status=$4 AND bytes >= $5 LIMIT 1`,
						[where.ownerType, where.ownerId, where.referenceKey, where.status, where.bytes.gte],
					)
				).rows[0] ?? null,
		},
		generationAttempt: {
			create: async ({ data }: { data: Record<string, unknown> }) => {
				const entries = Object.entries({ id: randomUUID(), ...data });
				return (
					await connection.query(
						`INSERT INTO ${fixture.table("generation_attempt")} (${entries.map(([key]) => `"${key}"`).join(",")}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(",")}) RETURNING *`,
						entries.map(([, value]) => value),
					)
				).rows[0];
			},
		},
		videoExecution: { update: updateVideo },
	} as unknown as Prisma.TransactionClient;
}

async function claimAndSimulateSubmit(jobId: string) {
	const result = await claimVideoProviderSubmission({
		jobId,
		callbackTokenHash: "test-callback-hash",
		providerModelId: "test-model",
		ruleVersion: "fixture-policy",
	});
	if ("deferred" in result) return { claimed: false, attemptId: null };
	// Returning claimed=true is the production permission for one provider POST.
	// No provider client is invoked here, including for repeated/unknown claims.
	if (result.claimed) simulatedProviderPosts.push(result.attempt.id);
	return { claimed: result.claimed, attemptId: result.attempt.id };
}

function settleNative(accepted: { jobId: string; reservationId: string }) {
	return fixture.transaction((tx) =>
		settleCreditsInTransaction(
			{
				reservationId: accepted.reservationId,
				amount: 5n,
				referenceKey: `settle:${accepted.jobId}`,
			},
			tx,
		),
	);
}

async function attemptState() {
	return (
		await fixture.rows(
			`SELECT count(*)::int AS attempts, count(*) FILTER (WHERE "uncertainSubmission")::int AS uncertain FROM ${fixture.table("generation_attempt")}`,
		)
	)[0];
}

async function ledgerState() {
	return (
		await fixture.rows(`SELECT count(*) FILTER (WHERE type='RESERVE')::int AS reserves,
		count(*) FILTER (WHERE type='SETTLE')::int AS settles,
		COALESCE(sum(amount) FILTER (WHERE type='RESERVE'),0)::bigint AS reserved,
		COALESCE(sum(amount) FILTER (WHERE type='SETTLE'),0)::bigint AS settled FROM ${fixture.table("credit_ledger_entry")}`)
	).map((row) => ({
		...row,
		reserved: BigInt(row.reserved as string),
		settled: BigInt(row.settled as string),
	}))[0];
}

async function fund(ownerId: string, amount: bigint) {
	await fixture.transaction(async (tx, connection) => {
		await connection.query(
			`INSERT INTO ${fixture.table("credit_account")} (id,"ownerType","ownerId") VALUES ($1,'USER',$1)`,
			[ownerId],
		);
		await createCreditGrant(
			{ accountId: ownerId, amount, referenceKey: `test:${ownerId}:grant` },
			tx,
		);
	});
}

async function quote(ownerId: string, key: string, decision = "ALLOW") {
	const record = {
		id: `${ownerId}:${key}`,
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-nano-banana-2-lite",
		catalogVersion: "test-catalog",
		pricingVersion: "test-pricing",
		credits: 5n,
		costMicros: 1n,
		inputSnapshot: { kind: "text-to-image", prompt: "Reviewed fixture" },
		pricingSnapshot: {},
		expiresAt: new Date("2099-01-01"),
		moderationDecision: decision,
		moderationProvider: "test",
		moderationRuleVersion: "fixture-policy",
		moderationReasonCode: decision,
	};
	await fixture.transaction((tx) =>
		tx.generationQuote.create({
			data: { ...record, inputFingerprint: fingerprintGenerationQuoteSecurityPayload(record) },
		} as never),
	);
	return {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		quoteId: record.id,
		idempotencyKey: key,
		inputAssetIds: [],
		expectedModerationRuleVersion: "fixture-policy",
		maximumConcurrentJobs: 1,
	};
}
const submit = (input: Awaited<ReturnType<typeof quote>>) =>
	createGenerationJobTransaction(input, fixture.client());
const balance = async (ownerId: string) =>
	(
		await fixture.rows(
			`SELECT "spendableCredits", "reservedCredits", "creditDebt" FROM ${fixture.table("credit_account")} WHERE "ownerId"=$1`,
			[ownerId],
		)
	)[0];
async function counts() {
	const [row] = await fixture.rows(`SELECT
		(SELECT count(*)::int FROM ${fixture.table("generation_job")}) AS jobs,
		(SELECT count(*)::int FROM ${fixture.table("credit_ledger_entry")} WHERE type='RESERVE') AS reserves,
		(SELECT count(*)::int FROM ${fixture.table("outbox_event")}) AS outbox`);
	return row;
}
