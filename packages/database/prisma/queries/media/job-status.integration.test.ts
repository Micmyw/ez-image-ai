import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isExplicitVideoVerificationTarget } from "../../../../../tests/load/video-verification-target";
import { PrismaClient, type Prisma } from "../../generated/client";
import { getOwnedMediaAssetReadState } from "./assets";
import { getOwnedGenerationJobStatus, MEDIA_JOB_STATUS_SELECT } from "./job-status";
import type { MediaDatabaseClient } from "./types";

let client: PrismaClient;
const statements: string[] = [];
const fixtureOwners: string[] = [];
const projectionSamples: Array<{
	label: string;
	queryCount: number;
	wallMs: number;
	payloadBytes: number;
	statements: string[];
}> = [];
const projectionPhase = process.env.STATUS_PROJECTION_PHASE;
beforeAll(() => {
	const url = new URL(process.env.TEST_DATABASE_URL!);
	if (
		url.hostname !== "127.0.0.1" ||
		(url.port !== "55432" && !isExplicitVideoVerificationTarget(url)) ||
		!/test/.test(url.pathname)
	)
		throw new Error("Unsafe database");
	client = new PrismaClient({
		adapter: new PrismaPg({ connectionString: url.toString() }),
		log: [{ emit: "event", level: "query" }],
	});
	(client as any).$on("query", (event: { query: string }) => statements.push(event.query));
});
afterAll(async () => {
	if (!client) return;
	try {
		if (projectionPhase) {
			if (!["baseline", "optimized"].includes(projectionPhase))
				throw new Error("Invalid projection phase");
			const directory = resolve(process.cwd(), "../../.cache/generation-one-second-20261022");
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				resolve(directory, `status-projection-v8-${projectionPhase}-${Date.now()}.json`),
				JSON.stringify(
					{
						scope:
							"isolated PostgreSQL status projection; no session, browser, provider or cloud timing",
						phase: projectionPhase,
						sourceSha256: createHash("sha256")
							.update(readFileSync(resolve(process.cwd(), "prisma/queries/media/job-status.ts")))
							.digest("hex"),
						fixtureOwners,
						samples: projectionSamples,
					},
					null,
					2,
				),
				{ flag: "wx" },
			);
		}
		// The isolated database owns fixture disposal; audit evidence is append-only.
	} finally {
		await client.$disconnect();
	}
});

describe("job status database projection", () => {
	it("reads only required columns; includes current evidence and enforces owner scope", async () => {
		const id = crypto.randomUUID();
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId: id,
				submittedByUserId: id,
				productKey: "image-fast",
				catalogVersion: "v1",
				pricingVersion: "v1",
				credits: 4n,
				costMicros: 1n,
				inputSnapshot: { kind: "text-to-image", prompt: "test" },
				pricingSnapshot: {},
				expiresAt: new Date(Date.now() + 60_000),
			},
		});
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: id,
				submittedByUserId: id,
				quoteId: quote.id,
				idempotencyKey: id,
				productKey: "image-fast",
				catalogVersion: "v1",
				pricingVersion: "v1",
				creditsReserved: 4n,
				inputSnapshot: quote.inputSnapshot!,
				pricingSnapshot: { providerPrivateData: "x".repeat(16384) },
			},
		});
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: id,
				kind: "OUTPUT",
				objectKey: `private/${id}`,
				mimeType: "image/png",
				byteSize: 128n,
				checksum: "a".repeat(64),
				sourceUrl: "https://private.invalid/output",
			},
		});
		await client.generationJobAsset.create({
			data: { jobId: job.id, assetId: asset.id, assetChecksum: "a".repeat(64), role: "OUTPUT" },
		});
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				status: "PENDING",
				verificationGeneration: 0,
				attemptNumber: 1,
				evidenceKind: "OUTPUT",
				provider: "test",
				ruleVersion: "v1",
				policyVersion: "v1",
				reasonCode: "IMAGE_PROCESSING",
				categories: {},
				rawEnvelope: { secret: "x".repeat(16384) },
			},
		});
		statements.length = 0;
		const started = performance.now();
		const current = await getOwnedGenerationJobStatus(job.id, id, client);
		const after = {
			queryCount: statements.length,
			wallMs: performance.now() - started,
			payloadBytes: jsonSize(current),
			assetColumns: Object.keys(current!.assets[0].asset).length,
		};
		expect(current?.assets[0].asset.moderationResults[0].status).toBe("PENDING");
		expect(current).not.toHaveProperty("pricingSnapshot");
		expect(current?.assets[0].asset).not.toHaveProperty("sourceUrl");
		expect(statements.join("\n")).not.toContain('"rawEnvelope"');
		expect(statements.join("\n")).not.toContain('"outputTransferToken"');
		expect(await getOwnedGenerationJobStatus(job.id, "other-user", client)).toBeNull();
		// Optional comparison uses the saved, timing-only baseline query, not a checkout reset.
		if (process.env.FLOW_SIMULATION_PHASE) {
			const directory = resolve(process.cwd(), "../../.cache/generation-batch1");
			const baseline = JSON.parse(
				readFileSync(resolve(directory, "preview-before.json"), "utf8"),
			).query;
			const oldRead = async () => {
				const prior: any = await client.generationJob.findFirst({
					...baseline,
					where: { id: job.id, ownerType: "USER", ownerId: id },
				});
				const access = await getOwnedMediaAssetReadState(
					{
						assetId: asset.id,
						ownerId: id,
						verification: {
							provider: "test",
							ruleVersion: "v1",
							policyVersion: "v1",
							now: new Date(),
						},
					},
					client,
				);
				return {
					payloadBytes: jsonSize(prior) + jsonSize(access),
					assetColumns: Object.keys(prior.assets[0].asset).length,
				};
			};
			const newRead = async () => {
				const state = await getOwnedGenerationJobStatus(job.id, id, client);
				return {
					payloadBytes: jsonSize(state),
					assetColumns: Object.keys(state!.assets[0].asset).length,
				};
			};
			// Warm both compiled queries before alternating their order on the same connection pool.
			await oldRead();
			await newRead();
			const samples: Array<{
				path: string;
				queryCount: number;
				wallMs: number;
				payloadBytes: number;
				assetColumns: number;
			}> = [];
			for (let index = 0; index < 10; index++) {
				for (const path of index % 2 ? ["after", "before"] : ["before", "after"]) {
					statements.length = 0;
					const start = performance.now();
					const metrics = await (path === "before" ? oldRead() : newRead());
					samples.push({
						path,
						queryCount: statements.length,
						wallMs: performance.now() - start,
						...metrics,
					});
				}
			}
			const before = samples.find((sample) => sample.path === "before")!;
			expect(after.payloadBytes).toBeLessThan(before.payloadBytes);
			expect(after.queryCount).toBeLessThan(before.queryCount);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				resolve(directory, "status-database-comparison.json"),
				JSON.stringify(
					{
						scope:
							"real isolated PostgreSQL projection plus legacy access lookup; single synthetic fixture, 10 alternating warmed samples per path; not production capacity evidence",
						before,
						after,
						samples,
						unmeasured: ["SQL server execution time", "connection wait", "Cloudflare latency"],
					},
					null,
					2,
				),
			);
		}
	});
});

function jsonSize(value: unknown) {
	return Buffer.byteLength(
		JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)),
	);
}

async function createStatusJob(overrides: Partial<Prisma.GenerationJobUncheckedCreateInput> = {}) {
	const ownerId = crypto.randomUUID();
	const videoJobId =
		overrides.executionEngine === "video-workflow-v1"
			? (overrides.id ?? crypto.randomUUID())
			: undefined;
	fixtureOwners.push(ownerId);
	const quote = await client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "v1",
			pricingVersion: "v1",
			credits: 17n,
			costMicros: 1n,
			inputSnapshot: { prompt: "status fixture" },
			pricingSnapshot: {},
			expiresAt: new Date("2099-01-01T00:00:00Z"),
		},
	});
	return client.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: ownerId,
			productKey: "image-fast",
			catalogVersion: "v1",
			pricingVersion: "v1",
			creditsReserved: 17n,
			inputSnapshot: {
				prompt: "status fixture",
				nested: { nullable: null, dateText: "2026-01-01" },
			},
			pricingSnapshot: { private: "not returned" },
			...overrides,
			...(videoJobId !== undefined
				? {
						id: videoJobId,
						videoExecution: {
							create: {
								workflowInstanceId: `video-v1-${videoJobId}`,
								modelContractVersion: "status-fixture-v1",
							},
						},
					}
				: {}),
		},
	});
}

async function createStatusFunding(
	job: { id: string; ownerId: string },
	input: { amount: bigint; settledAmount?: bigint; releasedAmount?: bigint },
) {
	// Retained status fixtures still need conserved lot and allocation balances.
	const settledAmount = input.settledAmount ?? 0n;
	const releasedAmount = input.releasedAmount ?? 0n;
	const reservedAmount = input.amount - settledAmount - releasedAmount;
	return client.$transaction(async (transaction) => {
		const account = await transaction.creditAccount.create({
			data: {
				ownerType: "USER",
				ownerId: job.ownerId,
				spendableCredits: releasedAmount,
				reservedCredits: reservedAmount,
			},
		});
		const lot = await transaction.creditLot.create({
			data: {
				accountId: account.id,
				grantReferenceKey: `status-fixture:${job.id}`,
				grantedAmount: input.amount,
				remainingAmount: releasedAmount,
				reservedAmount,
			},
		});
		const reservation = await transaction.creditReservation.create({
			data: {
				jobId: job.id,
				accountId: account.id,
				amount: input.amount,
				settledAmount,
				releasedAmount,
				status: reservedAmount === 0n ? "SETTLED" : "ACTIVE",
				allocations: {
					create: { lotId: lot.id, amount: input.amount, settledAmount, releasedAmount },
				},
			},
		});
		return { account, lot, reservation };
	});
}

async function createStatusAsset(
	ownerId: string,
	overrides: Partial<Prisma.MediaAssetUncheckedCreateInput> = {},
) {
	return client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: `status/${crypto.randomUUID()}`,
			mimeType: "image/png",
			byteSize: 128n,
			checksum: "a".repeat(64),
			...overrides,
		},
	});
}

async function createStatusEvidence(
	assetId: string,
	overrides: Partial<Prisma.AssetModerationResultUncheckedCreateInput> = {},
) {
	return client.assetModerationResult.create({
		data: {
			assetId,
			assetChecksum: "a".repeat(64),
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "OUTPUT",
			provider: "test",
			providerTaskId: "task",
			ruleVersion: "v1",
			policyVersion: "v1",
			status: "APPROVED",
			reasonCode: "SAFE",
			categories: {},
			rawEnvelope: { private: "not returned" },
			validUntil: new Date("2099-01-01T00:00:00.123Z"),
			...overrides,
		},
	});
}

async function readEquivalentStatus(
	label: string,
	jobId: string,
	ownerId: string,
	database: MediaDatabaseClient = client,
) {
	statements.length = 0;
	const started = performance.now();
	const result = await getOwnedGenerationJobStatus(jobId, ownerId, database);
	const sample = {
		label,
		queryCount: statements.length,
		wallMs: performance.now() - started,
		payloadBytes: jsonSize(result),
		statements: [...statements],
	};
	projectionSamples.push(sample);
	// The old Prisma projection is an independent oracle for values, nulls, order,
	// Date and bigint types. Its own queries are excluded from measured samples.
	const reference = await database.generationJob.findFirst({
		where: { id: jobId, executionEngine: "legacy", ownerType: "USER", ownerId },
		select: MEDIA_JOB_STATUS_SELECT,
	});
	expect(result).toStrictEqual(reference);
	if (projectionPhase !== "baseline") expect(sample.queryCount).toBe(1);
	expect(sample.statements.join("\n")).not.toMatch(
		/"(?:rawEnvelope|sourceUrl|pricingSnapshot|outputTransferToken|verificationLastErrorCode)"/,
	);
	return result;
}

describe("single-statement job status equivalence", () => {
	it("preserves empty relations, nullable fields, native dates and bigint precision", async () => {
		const large = 9_007_199_254_740_993n;
		const date = new Date("2026-10-22T12:34:56.789Z");
		const job = await createStatusJob({
			status: "SUCCEEDED",
			creditsReserved: large,
			createdAt: date,
		});
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId: job.ownerId },
		});
		await client.creditReservation.create({
			data: {
				jobId: job.id,
				accountId: account.id,
				amount: large,
				settledAmount: large - 1n,
				releasedAmount: 1n,
				status: "SETTLED",
			},
		});
		await client.generationJob.update({
			where: { id: job.id },
			data: { archivedCreditsCharged: large - 1n, archivedCreditsReleased: 1n },
		});
		await client.creditReservation.delete({ where: { jobId: job.id } });
		const result = await readEquivalentStatus("empty-relations", job.id, job.ownerId);
		expect(result).toMatchObject({
			creditsReserved: large,
			archivedCreditsCharged: large - 1n,
			archivedCreditsReleased: 1n,
			reservation: null,
			imagePassReservation: null,
			attempts: [],
			assets: [],
			_count: { attempts: 0 },
			createdAt: date,
		});
	});

	it("preserves full funding, binding order, duplicate asset bindings and complete evidence", async () => {
		const job = await createStatusJob({ status: "FINALIZING" });
		const large = 9_007_199_254_740_993n;
		const date = new Date("2026-10-22T12:34:56.789Z");
		await createStatusFunding(job, {
			amount: large + 2n,
			settledAmount: large,
			releasedAmount: 2n,
		});
		const output = await createStatusAsset(job.ownerId, {
			byteSize: large,
			durationMillis: large + 1n,
			width: 1920,
			height: 1080,
			createdAt: date,
			updatedAt: date,
			verificationGeneration: 2,
			verificationAttemptCount: 3,
			verificationProvider: "test",
			verificationProviderTaskId: "task",
			verificationRuleVersion: "v1",
			verificationPolicyVersion: "v1",
			verificationValidUntil: date,
		});
		const input = await createStatusAsset(job.ownerId, {
			kind: "INPUT",
			status: "VERIFYING",
			deleteAfter: date,
			deletedAt: date,
		});
		await client.generationJobAsset.createMany({
			data: [
				{
					id: `${job.id}-d`,
					jobId: job.id,
					assetId: output.id,
					assetChecksum: "a".repeat(64),
					role: "OUTPUT",
					position: 2,
				},
				{
					id: `${job.id}-b`,
					jobId: job.id,
					assetId: input.id,
					assetChecksum: "a".repeat(64),
					role: "INPUT",
					position: 0,
				},
				{
					id: `${job.id}-a`,
					jobId: job.id,
					assetId: output.id,
					assetChecksum: "a".repeat(64),
					role: "INPUT",
					position: 0,
				},
			],
		});
		await createStatusEvidence(output.id, {
			verificationGeneration: 1,
			attemptNumber: 99,
			createdAt: new Date("2099-01-01"),
		});
		await createStatusEvidence(output.id, {
			verificationGeneration: 2,
			attemptNumber: 2,
			createdAt: new Date("2099-01-01"),
		});
		const rejected = await createStatusEvidence(output.id, {
			verificationGeneration: 2,
			attemptNumber: 3,
			status: "REJECTED",
			reasonCode: "SEXUAL_CONTENT",
			validUntil: null,
			createdAt: date,
		});
		await client.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: "test",
				providerModelId: "private",
				requestSnapshot: {},
				status: "SUCCEEDED",
				progress: 100,
			},
		});
		const result = await readEquivalentStatus("full-relations", job.id, job.ownerId);
		expect(result?.reservation).toEqual({
			status: "SETTLED",
			settledAmount: large,
			releasedAmount: 2n,
		});
		expect(result?.assets.map(({ asset }) => asset.id)).toEqual([output.id, input.id, output.id]);
		expect(result?.assets[0].asset).toMatchObject({
			byteSize: large,
			durationMillis: large + 1n,
			verificationValidUntil: date,
			moderationResults: [{ id: rejected.id, status: "REJECTED", validUntil: null }],
		});
		expect(result?.assets[1].asset.moderationResults).toEqual([]);
	});

	it("counts every unresolved attempt even when the latest attempt is safe", async () => {
		const job = await createStatusJob({ status: "PROVIDER_RUNNING" });
		await client.generationAttempt.createMany({
			data: [
				{ attemptNumber: 1, status: "FAILED" as const, uncertainSubmission: true },
				{ attemptNumber: 2, status: "SUBMISSION_UNCERTAIN" as const, uncertainSubmission: true },
				{ attemptNumber: 3, status: "NEEDS_RECONCILIATION" as const, uncertainSubmission: false },
				{ attemptNumber: 4, status: "RUNNING" as const, uncertainSubmission: false },
			].map((attempt) => ({
				...attempt,
				jobId: job.id,
				provider: "test",
				providerModelId: "private",
				requestSnapshot: {},
				progress: attempt.attemptNumber,
			})),
		});
		const result = await readEquivalentStatus("historical-uncertainty", job.id, job.ownerId);
		expect(result?._count.attempts).toBe(3);
		expect(result?.attempts).toMatchObject([
			{ progress: 4, status: "RUNNING", uncertainSubmission: false },
		]);
	});

	it.each(["PENDING", "REJECTED", "ERROR", "REVIEW", "BYPASSED"] as const)(
		"reads a new %s verdict instead of an older approval without requiring a job update",
		async (status) => {
			const job = await createStatusJob();
			const asset = await createStatusAsset(job.ownerId);
			await client.generationJobAsset.create({
				data: { jobId: job.id, assetId: asset.id, assetChecksum: "a".repeat(64), role: "OUTPUT" },
			});
			const evidence = await createStatusEvidence(asset.id);
			await client.mediaAsset.update({
				where: { id: asset.id },
				data: {
					status: "READY",
					verificationGeneration: 1,
					verificationAttemptCount: 1,
					verificationProvider: "test",
					verificationProviderTaskId: "task",
					verificationRuleVersion: "v1",
					verificationPolicyVersion: "v1",
					verificationValidUntil: evidence.validUntil,
				},
			});
			const approved = await readEquivalentStatus(`before-${status}`, job.id, job.ownerId);
			const newer = await createStatusEvidence(asset.id, {
				attemptNumber: 2,
				status,
				validUntil: new Date(0),
				...(status === "BYPASSED" ? { reasonCode: "MODERATION_TECHNICAL_FAILURE_BYPASS" } : {}),
			});
			await client.mediaAsset.update({
				where: { id: asset.id },
				data: {
					status: "QUARANTINED",
					deletedAt: new Date(0),
					deleteAfter: new Date(0),
					verificationValidUntil: new Date(0),
				},
			});
			const revoked = await readEquivalentStatus(`after-${status}`, job.id, job.ownerId);
			expect(revoked?.version).toBe(approved?.version);
			expect(revoked?.assets[0].asset).toMatchObject({
				status: "QUARANTINED",
				deletedAt: new Date(0),
				deleteAfter: new Date(0),
				verificationValidUntil: new Date(0),
				moderationResults: [{ id: newer.id, status, validUntil: new Date(0) }],
			});
		},
	);

	it("enforces owner and legacy engine in the statement and binds hostile strings as values", async () => {
		const job = await createStatusJob({ id: `status-'---${crypto.randomUUID()}` });
		expect(await readEquivalentStatus("quoted-id", job.id, job.ownerId)).not.toBeNull();
		expect(
			await readEquivalentStatus("foreign-owner", job.id, `${job.ownerId}' OR TRUE --`),
		).toBeNull();
		expect(await readEquivalentStatus("absent-job", "' OR TRUE --", job.ownerId)).toBeNull();
		const video = await createStatusJob({ executionEngine: "video-workflow-v1" });
		expect(await readEquivalentStatus("foreign-engine", video.id, video.ownerId)).toBeNull();
		const organization = await createStatusJob({ ownerType: "ORGANIZATION" });
		expect(
			await readEquivalentStatus("organization-owner", organization.id, organization.ownerId),
		).toBeNull();
	});

	it("keeps foreign binding ownership visible to the API authorization filter", async () => {
		const job = await createStatusJob();
		const foreign = await createStatusJob();
		const asset = await createStatusAsset(foreign.ownerId, { kind: "INPUT" });
		await client.generationJobAsset.create({
			data: { jobId: job.id, assetId: asset.id, assetChecksum: "a".repeat(64), role: "INPUT" },
		});
		const result = await readEquivalentStatus("foreign-asset", job.id, job.ownerId);
		expect(result?.assets[0].asset.ownerId).toBe(foreign.ownerId);
	});

	it.each(["ACTIVE", "SETTLED", "RELEASED"])(
		"preserves image-pass funding and observes %s reservation state",
		async (status) => {
			const job = await createStatusJob({ fundingSource: "IMAGE_PASS", creditsReserved: 0n });
			const plan = await client.billingPlan.create({
				data: {
					provider: "test",
					providerPriceId: job.ownerId,
					name: "status",
					creditsPerPeriod: 0n,
					priceMicros: 0n,
					currency: "USD",
					metadata: {},
				},
			});
			const checkout = await client.paymentCheckoutIntent.create({
				data: {
					provider: "test",
					ownerType: "USER",
					ownerId: job.ownerId,
					submittedByUserId: job.ownerId,
					billingPlanId: plan.id,
					planKey: "test",
					interval: "once",
					idempotencyKey: job.ownerId,
				},
			});
			const grant = await client.imagePassGrant.create({
				data: {
					checkoutIntentId: checkout.id,
					ownerId: job.ownerId,
					provider: "paypal",
					providerOrderId: job.ownerId,
					providerPaymentId: job.ownerId,
					paidAmountMicros: 1_000_000n,
					currency: "USD",
					offerSnapshot: {},
					paidAt: new Date(),
					units: { create: [1, 2, 3].map((ordinal) => ({ ordinal })) },
				},
				include: { units: { orderBy: { ordinal: "asc" } } },
			});
			const reservation = await client.imagePassReservation.create({
				data: { jobId: job.id, ownerId: job.ownerId, unitId: grant.units[0].id },
			});
			await client.imagePassReservation.update({
				where: { id: reservation.id },
				data: { status, finalizedAt: status === "ACTIVE" ? null : new Date() },
			});
			expect(await readEquivalentStatus(`image-pass-${status}`, job.id, job.ownerId)).toMatchObject(
				{
					fundingSource: "IMAGE_PASS",
					creditsReserved: 0n,
					reservation: null,
					imagePassReservation: { status },
				},
			);
		},
	);

	it("reuses a caller transaction and reads its fresh settlement and asset state", async () => {
		const job = await createStatusJob({ status: "FAILED" });
		const funding = await createStatusFunding(job, { amount: 17n });
		expect(
			(await readEquivalentStatus("before-settlement", job.id, job.ownerId))?.reservation,
		).toEqual({ status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n });
		await client.$transaction(async (transaction) => {
			await transaction.creditReservation.update({
				where: { jobId: job.id },
				data: { status: "SETTLED", settledAmount: 5n, releasedAmount: 12n },
			});
			await transaction.creditReservationAllocation.update({
				where: {
					reservationId_lotId: { reservationId: funding.reservation.id, lotId: funding.lot.id },
				},
				data: { settledAmount: 5n, releasedAmount: 12n },
			});
			await transaction.creditLot.update({
				where: { id: funding.lot.id },
				data: { remainingAmount: 12n, reservedAmount: 0n },
			});
			await transaction.creditAccount.update({
				where: { id: funding.account.id },
				data: { spendableCredits: 12n, reservedCredits: 0n },
			});
			expect(
				(await readEquivalentStatus("transaction-settlement", job.id, job.ownerId, transaction))
					?.reservation,
			).toEqual({ status: "SETTLED", settledAmount: 5n, releasedAmount: 12n });
		});
		expect(
			(await readEquivalentStatus("committed-settlement", job.id, job.ownerId))?.reservation,
		).toEqual({ status: "SETTLED", settledAmount: 5n, releasedAmount: 12n });
	});
});
