import { PrismaPg } from "@prisma/adapter-pg";
import { temporaryReferenceObjectKey, type TemporaryReference } from "@repo/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { localSqlMetricsEnabled } from "../../query-metrics";
import { getTemporaryReferenceStatus } from "./temporary-reference-status";

let database: PrismaClient;
let client: Prisma.TransactionClient;
let transaction: Promise<void>;
let finishTransaction: () => void;
const rollback = new Error("ROLLBACK_STATUS_TEST_FIXTURE");
const verification = {
	provider: "seeapi",
	ruleVersion: "reference-rule",
	policyVersion: "reference-policy",
};

beforeAll(() => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (
		!connectionString ||
		connectionString === process.env.DATABASE_URL ||
		!localSqlMetricsEnabled(connectionString, "true")
	)
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	database = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 2 }) });
});
beforeEach(async () => {
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const finished = new Promise<void>((resolve) => {
		finishTransaction = resolve;
	});
	transaction = database
		.$transaction(
			async (tx) => {
				client = tx;
				enter();
				await finished;
				throw rollback;
			},
			{ timeout: 20_000 },
		)
		.catch((error) => {
			if (error !== rollback) throw error;
		});
	await Promise.race([
		entered,
		transaction.then(() => {
			throw new Error("STATUS_TEST_TRANSACTION_NOT_OPEN");
		}),
	]);
});
afterEach(async () => {
	finishTransaction?.();
	await transaction;
});
afterAll(() => database?.$disconnect());

async function fixture(withAsset = true, assetData: Partial<Prisma.MediaAssetCreateInput> = {}) {
	const now = new Date();
	const reference: TemporaryReference = {
		v: 1,
		ownerId: `reference-status-${crypto.randomUUID()}`,
		assetId: crypto.randomUUID(),
		contentType: "image/png",
		bytes: 1000,
		checksum: "a".repeat(64),
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
	};
	const reservation = await client.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId: reference.ownerId,
			bytes: BigInt(reference.bytes),
			status: "COMMITTED",
			referenceKey: `temporary-reference:${reference.assetId}`,
			expiresAt: new Date(reference.expiresAt),
		},
	});
	if (withAsset)
		await client.mediaAsset.create({
			data: {
				id: reference.assetId,
				ownerType: "USER",
				ownerId: reference.ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: temporaryReferenceObjectKey(reference),
				mimeType: reference.contentType,
				byteSize: BigInt(reference.bytes),
				checksum: reference.checksum,
				finalizedAt: now,
				deleteAfter: new Date(reference.expiresAt),
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: verification.provider,
				verificationProviderTaskId: `${reference.assetId}:task`,
				verificationRuleVersion: verification.ruleVersion,
				verificationPolicyVersion: verification.policyVersion,
				...assetData,
			},
		});
	const read = (override: Partial<Parameters<typeof getTemporaryReferenceStatus>[0]> = {}) =>
		getTemporaryReferenceStatus(
			{ ownerId: reference.ownerId, reference, verification, ...override },
			client,
		);
	const verdict = async (
		status: "APPROVED" | "REJECTED" | "ERROR",
		reasonCode: string,
		evidenceData: Partial<Prisma.AssetModerationResultUncheckedCreateInput> = {},
	) => {
		const validUntil =
			status === "APPROVED" ? (evidenceData.validUntil ?? new Date(Date.now() + 60000)) : null;
		await client.assetModerationResult.create({
			data: {
				assetId: reference.assetId,
				assetChecksum: reference.checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: verification.provider,
				providerTaskId: `${reference.assetId}:task`,
				ruleVersion: verification.ruleVersion,
				policyVersion: verification.policyVersion,
				status,
				reasonCode,
				categories: { private: "detector" },
				rawEnvelope: { private: "provider-response" },
				validUntil,
				...evidenceData,
			},
		});
		await client.mediaAsset.update({
			where: { id: reference.assetId },
			data: {
				status:
					status === "APPROVED"
						? "READY"
						: status === "REJECTED"
							? "QUARANTINED"
							: "VERIFICATION_FAILED",
				verificationValidUntil: validUntil,
			},
		});
	};
	return { reference, reservation, read, verdict };
}

describe("temporary reference status read", () => {
	it("reports pure upload without starting an audit, creating an asset or reserving credits", async () => {
		const f = await fixture(false);
		expect(await f.read()).toEqual({
			status: "NOT_STARTED",
			moderationStatus: null,
			reasonCode: null,
		});
		expect(await client.mediaAsset.findUnique({ where: { id: f.reference.assetId } })).toBeNull();
		expect(await client.outboxEvent.count({ where: { aggregateId: f.reference.assetId } })).toBe(0);
		expect(await client.creditAccount.count({ where: { ownerId: f.reference.ownerId } })).toBe(0);
	});
	it("observes pending and matching approved review without mutating it or returning private fields", async () => {
		const f = await fixture();
		expect(await f.read()).toEqual({ status: "PENDING", moderationStatus: null, reasonCode: null });
		await f.verdict("APPROVED", "NO_POLICY_MATCH");
		const before = await client.mediaAsset.findUnique({ where: { id: f.reference.assetId } });
		expect(await f.read()).toEqual({
			status: "APPROVED",
			moderationStatus: "APPROVED",
			reasonCode: "NO_POLICY_MATCH",
		});
		expect(await client.mediaAsset.findUnique({ where: { id: f.reference.assetId } })).toEqual(
			before,
		);
	});
	it.each([
		["REJECTED", "SEEAPI_CONTENT_NOT_ALLOWED"],
		["ERROR", "MODERATION_TIMEOUT"],
	] as const)(
		"preserves the %s vs technical-error distinction for safe API mapping",
		async (status, reasonCode) => {
			const f = await fixture();
			await f.verdict(status, reasonCode);
			expect(await f.read()).toEqual({
				status: "UNAVAILABLE",
				moderationStatus: status,
				reasonCode,
			});
		},
	);
	it("denies cross-owner references before reading any database state", async () => {
		const f = await fixture();
		await expect(f.read({ ownerId: "other-owner" })).rejects.toThrow("TEMPORARY_REFERENCE_INVALID");
	});
	it.each([
		{ ownerId: "other-owner" },
		{ objectKey: `private/other-object-${crypto.randomUUID()}` },
		{ checksum: "b".repeat(64) },
		{ byteSize: 999n },
		{ mimeType: "image/webp" },
		{ deleteAfter: new Date("2020-01-01T00:00:00Z") },
		{ deletedAt: new Date() },
		{ verificationEngine: "video-workflow-v1" },
		{ kind: "OUTPUT" },
		{ retentionClass: "GUEST_TRIAL" },
		{ finalizedAt: null },
	] satisfies Partial<Prisma.MediaAssetCreateInput>[])(
		"denies an immutable identity or lifetime mismatch: %o",
		async (data) => {
			const f = await fixture(true, data);
			expect(await f.read()).toBeNull();
		},
	);
	it.each([
		{ ownerId: "other-owner" },
		{ bytes: 999n },
		{ status: "ACTIVE" },
		{ expiresAt: new Date("2020-01-01T00:00:00Z") },
	] satisfies Prisma.StorageUsageReservationUpdateInput[])(
		"denies an invalid upload reservation: %o",
		async (data) => {
			const f = await fixture(false);
			await client.storageUsageReservation.update({ where: { id: f.reservation.id }, data });
			expect(await f.read()).toBeNull();
		},
	);
	it("uses database expiry even if the request clock says the reference is current", async () => {
		const f = await fixture(false);
		const expiresAt = new Date(Date.now() - 1000);
		const reference = {
			...f.reference,
			createdAt: new Date(expiresAt.getTime() - 86_400_000).toISOString(),
			expiresAt: expiresAt.toISOString(),
		};
		await client.storageUsageReservation.update({
			where: { id: f.reservation.id },
			data: { expiresAt },
		});
		expect(await f.read({ reference, now: new Date(expiresAt.getTime() - 1000) })).toBeNull();
	});
	it.each([
		{ providerTaskId: "another-task" },
		{ verificationGeneration: 2 },
		{ attemptNumber: 2 },
		{ assetChecksum: "b".repeat(64) },
		{ ruleVersion: "old-rule" },
		{ policyVersion: "old-policy" },
	] satisfies Partial<Prisma.AssetModerationResultUncheckedCreateInput>[])(
		"never exposes a historical or mismatched rejection as the current verdict: %o",
		async (data) => {
			const f = await fixture();
			await f.verdict("REJECTED", "SEEAPI_CONTENT_NOT_ALLOWED", data);
			expect(await f.read()).toEqual({
				status: "UNAVAILABLE",
				moderationStatus: null,
				reasonCode: null,
			});
		},
	);
	it("uses database time to stop presenting an expired review as approved", async () => {
		const f = await fixture();
		const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		await f.verdict("APPROVED", "NO_POLICY_MATCH", {
			validUntil: new Date(clock!.now.getTime() + 250),
		});
		expect(await f.read()).toMatchObject({ status: "APPROVED" });
		await client.$queryRaw`SELECT 1 FROM pg_sleep(0.3)`;
		expect(await f.read()).toMatchObject({ status: "UNAVAILABLE" });
	});
	it("does not reuse an approval under a changed runtime policy", async () => {
		const f = await fixture();
		await f.verdict("APPROVED", "NO_POLICY_MATCH");
		expect(
			await f.read({ verification: { ...verification, policyVersion: "next-policy" } }),
		).toMatchObject({ status: "UNAVAILABLE" });
	});
});
