import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stop the default connection at the established boundary. No PrismaClient is
// fabricated or constructed; runtime SQL utilities use the installed package.
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("UNEXPECTED_DEFAULT_DATABASE_CLIENT");
	},
}));
vi.mock("#prisma-runtime-client", async () => {
	const { join } = await import("@prisma/client/runtime/client");
	return { Prisma: { join } };
});

import { AccountInputCopyPostgresPort } from "../../../test-support/account-input-copy-postgres-port";
import {
	claimAccountInputCopy,
	claimAccountInputCopyOrphan,
	commitAccountInputCopy,
	createAccountInputCopyInTransaction,
	failAccountInputCopy,
	getAccountInputCopyStatus,
	parseAccountInputCopyIntent,
	reconcileAccountInputCopyTargetInTransaction,
	recordAccountInputCopyOrphanPass,
	recoverAccountInputCopies,
	registerAccountInputCopyMultipart,
} from "./account-input-copy";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import { unexpiredStorageReservations } from "./temporary-references";

const fixture = new AccountInputCopyPostgresPort();
const checksum = "a".repeat(64);
beforeAll(() => fixture.initialize());
beforeEach(async () => {
	vi.stubEnv("ACCOUNT_INPUT_COPY_ENABLED", "true");
	vi.stubEnv("MEDIA_MAX_STORAGE_BYTES", "1000");
	await fixture.reset();
	await fixture.rows(`INSERT INTO ${fixture.table("credit_account")} VALUES ('untouched',19,3)`);
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await fixture.close();
});

// These execute real PostgreSQL transactions, row/advisory locks and production
// copy/quota/evidence functions. A submitted draft is seeded because this helper
// is explicitly called AFTER the exclusive draft claim; this is not evidence of
// the complete claim/link entrypoints or generated Prisma mappings/storage I/O.
describe("account input verified copy through a disposable PostgreSQL SQL port", () => {
	it("serializes duplicate creation to one fresh account target without touching guest source or accounting", async () => {
		const input = await seed("duplicate");
		const before = await sourceSnapshot(input.assetId);
		expect(await Promise.all(Array.from({ length: 12 }, () => create(input)))).toEqual(
			Array(12).fill(true),
		);
		const rows = await intents();
		expect(rows).toHaveLength(1);
		const p = parseAccountInputCopyIntent(rows[0]?.payload);
		expect(p.target.assetId).not.toBe(input.assetId);
		expect(p.target.objectKey).toMatch(
			/^users\/account\/assets\/[^/]+\/versions\/[^/]+\/original\.png$/,
		);
		expect(p.target.objectKey).not.toBe(p.source.objectKey);
		expect(p.source).toMatchObject({
			assetId: input.assetId,
			ownerId: "guest",
			checksum,
			bytes: 100,
		});
		expect(await target(p.target.assetId)).toMatchObject({
			ownerId: "account",
			status: "UPLOADING",
			retentionClass: "ACCOUNT",
			checksum: null,
		});
		expect(
			await fixture.rows(
				`SELECT "eventType",status,payload FROM ${fixture.table("outbox_event")} WHERE "dedupeKey"=$1`,
				[`account-input-copy-target:${p.target.assetId}`],
			),
		).toEqual([
			{
				eventType: "ACCOUNT_INPUT_COPY_TARGET",
				status: "PROCESSED",
				payload: { promotionId: rows[0]?.id },
			},
		]);
		expect(await sourceSnapshot(input.assetId)).toEqual(before);
		expect(await accountReservations()).toMatchObject([
			{ bytes: 100n, status: "ACTIVE", referenceKey: `account-input-copy:${p.target.assetId}` },
		]);
		expect(
			await fixture.rows(
				`SELECT "eventType" FROM ${fixture.table("outbox_event")} WHERE "eventType"='ACCOUNT_INPUT_COPY_REQUESTED'`,
			),
		).toHaveLength(1);
		await noCreditOrJobChanges();
	});

	it("keeps a current quarantined REVIEW available for normal manual review", async () => {
		const { input, promotionId, p } = await prepared("target-content-review");
		await commit((await claimAccountInputCopy({ promotionId }, fixture.client()))!);
		await review(p.target.assetId);
		expect(
			await fixture.transaction((tx) =>
				reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx),
			),
		).toEqual({ terminal: false });
		expect(await target(p.target.assetId)).toMatchObject({
			status: "QUARANTINED",
			deletedAt: null,
		});
		expect((await intent(promotionId)).phase).toBe("VERIFYING");
		expect(await status(input)).toMatchObject({ status: "VERIFYING" });
		expect(await claimAccountInputCopyOrphan({ promotionId }, fixture.client())).toBeNull();
		expect(await accountReservations()).toMatchObject([{ status: "COMMITTED" }]);
		expect(
			await fixture.rows(
				`SELECT id FROM ${fixture.table("outbox_event")} WHERE "eventType"='ACCOUNT_INPUT_COPY_ORPHAN_CHECK'`,
			),
		).toEqual([]);
		await noCreditOrJobChanges();
	});

	it.each(["APPROVE", "RECHECK"])(
		"accepts the standard %s transitions after retaining a target content REVIEW",
		async (action) => {
			const { input, promotionId, p } = await prepared(`manual-${action}`);
			await commit((await claimAccountInputCopy({ promotionId }, fixture.client()))!);
			await review(p.target.assetId);
			await fixture.transaction((tx) =>
				reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx),
			);
			expect(await target(p.target.assetId)).toMatchObject({ deletedAt: null });
			if (action === "RECHECK") {
				// The existing admin RECHECK starts a fresh normal verification generation.
				await fixture.rows(
					`UPDATE ${fixture.table("media_asset")} SET status='VERIFYING',"verificationGeneration"=2,"verificationAttemptCount"=0 WHERE id=$1`,
					[p.target.assetId],
				);
				expect(await status(input)).toMatchObject({ status: "VERIFYING" });
			}
			await approve(p.target.assetId, {
				verificationGeneration: action === "RECHECK" ? 2 : 1,
				evidenceGeneration: action === "RECHECK" ? 2 : 1,
				attemptNumber: action === "RECHECK" ? 1 : 3,
			});
			await fixture.transaction((tx) =>
				reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx),
			);
			expect(await status(input)).toMatchObject({ status: "READY" });
			expect((await intent(promotionId)).phase).toBe("READY");
		},
	);

	it.each([
		["assetChecksum", "b".repeat(64)],
		["verificationGeneration", "0"],
		["attemptNumber", "1"],
		["evidenceKind", "OUTPUT"],
		["provider", "another-provider"],
		["providerTaskId", "another-task"],
		["ruleVersion", "another-rule"],
		["policyVersion", "another-policy"],
		["validUntil", "2000-01-01T00:00:00.000Z"],
	])("fails closed for a quarantined target REVIEW with stale %s", async (field, value) => {
		const { input, promotionId, p } = await prepared(`review-stale-${field}`);
		await commit((await claimAccountInputCopy({ promotionId }, fixture.client()))!);
		await review(p.target.assetId);
		await fixture.rows(
			`UPDATE ${fixture.table("asset_moderation_result")} SET "${field}"=$2 WHERE "assetId"=$1`,
			[p.target.assetId, value],
		);
		expect(await status(input)).toMatchObject({ status: "FAILED" });
		expect(
			await fixture.transaction((tx) =>
				reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx),
			),
		).toEqual({ terminal: true });
		expect(await target(p.target.assetId)).toMatchObject({ status: "DELETED" });
	});

	it.each(["source", "target"])("keeps a genuine %s rejection terminal", async (location) => {
		const { input, promotionId, p } = await prepared(`rejected-${location}`);
		if (location === "target")
			await commit((await claimAccountInputCopy({ promotionId }, fixture.client()))!);
		await review(location === "target" ? p.target.assetId : p.source.assetId, "REJECTED");
		if (location === "target")
			expect(
				await fixture.transaction((tx) =>
					reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx),
				),
			).toEqual({ terminal: true });
		else expect(await claimAccountInputCopy({ promotionId }, fixture.client())).toBeNull();
		expect(await status(input)).toMatchObject({ status: "FAILED" });
		expect(await claimAccountInputCopyOrphan({ promotionId }, fixture.client())).toMatchObject({
			objectKey: p.target.objectKey,
		});
	});

	it("waits for normal manual review of the source before granting a copy writer", async () => {
		const { input, promotionId, p } = await prepared("source-content-review");
		await review(input.assetId);
		expect(await claimAccountInputCopy({ promotionId }, fixture.client())).toBeNull();
		expect((await intent(promotionId)).phase).toBe("PENDING");
		expect(await target(p.target.assetId)).toMatchObject({ status: "UPLOADING", deletedAt: null });
		expect(await status(input)).toMatchObject({ status: "COPYING" });
		expect(await accountReservations()).toMatchObject([{ status: "ACTIVE" }]);
		await approve(input.assetId, { attemptNumber: 3 });
		expect(await claimAccountInputCopy({ promotionId }, fixture.client())).toMatchObject({
			promotionId,
		});
		await noCreditOrJobChanges();
	});

	it("denies another registered owner creation and status lookup", async () => {
		const input = await seed("owner");
		await create(input);
		await fixture.rows(`INSERT INTO ${fixture.table("user")} VALUES ('other-account',false)`);
		await expect(create({ ...input, nextOwnerId: "other-account" })).rejects.toThrow(
			"DRAFT_UNAVAILABLE",
		);
		expect(
			await getAccountInputCopyStatus(
				{ ownerId: "other-account", draftId: input.draftId },
				fixture.client(),
			),
		).toBeNull();
		expect(
			await getAccountInputCopyStatus(
				{ ownerId: "account", draftId: input.draftId },
				fixture.client(),
			),
		).toMatchObject({ status: "COPYING" });
		expect(await intents()).toHaveLength(1);
	});
	it("terminalizes a withdrawn draft before granting any storage writer", async () => {
		const { promotionId, input, p } = await prepared("withdrawn-before-copy");
		await fixture.rows(`DELETE FROM ${fixture.table("generation_draft")} WHERE id=$1`, [
			input.draftId,
		]);
		expect(await claimAccountInputCopy({ promotionId }, fixture.client())).toBeNull();
		expect(await status(input)).toMatchObject({ status: "FAILED" });
		expect(await target(p.target.assetId)).toMatchObject({ status: "DELETED" });
		await recordAccountInputCopyOrphanPass({ promotionId }, fixture.client());
		expect(await accountReservations()).toMatchObject([{ status: "RELEASED" }]);
		await noCreditOrJobChanges();
	});

	it("has no three-input count cap when aggregate bytes fit", async () => {
		const inputs = await Promise.all(Array.from({ length: 4 }, (_, i) => seed(`many-${i}`)));
		expect(await Promise.all(inputs.map(create))).toEqual([true, true, true, true]);
		expect(await intents()).toHaveLength(4);
		expect(await accountReservations()).toHaveLength(4);
		await noCreditOrJobChanges();
	});

	it("uses the real owner advisory lock to admit one of two competing free-account reservations", async () => {
		const inputs = await Promise.all([seed("quota-a"), seed("quota-b")]);
		await reserve("account", 850n, "existing");
		let release!: () => void;
		let acquired!: () => void;
		const ready = new Promise<void>((resolve) => {
			acquired = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holder = fixture.transaction(async (tx) => {
			await lockOwnerStorageUsage({ ownerType: "USER", ownerId: "account" }, tx);
			acquired();
			await gate;
		});
		await ready;
		const pending = Promise.allSettled(inputs.map(create));
		try {
			await waitForAdvisoryWaiters(2);
			expect(await intents()).toHaveLength(0);
		} finally {
			release();
			await holder;
		}
		const results = await pending;
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" ? rejected.reason.message : "missing rejection").toBe(
			"STORAGE_QUOTA_EXCEEDED",
		);
		expect(await intents()).toHaveLength(1);
		expect(await accountReservations()).toHaveLength(2);
		await noCreditOrJobChanges();
	});

	it.each(["ACTIVE", "CANCELED", "PAST_DUE"])(
		"uses real effective %s paid entitlement for unlimited aggregate storage",
		async (status) => {
			const input = await seed(`paid-${status}`);
			await reserve("account", 5000n, "already-over-free-cap");
			await subscription({ status });
			expect(await create(input)).toBe(true);
			expect(await accountReservations()).toHaveLength(2);
			await noCreditOrJobChanges();
		},
	);

	it.each(["refunded", "expired", "terminating"])(
		"retains the finite free cap for %s subscriptions",
		async (state) => {
			const input = await seed(`not-paid-${state}`);
			await reserve("account", 950n, "almost-full");
			await subscription({ state });
			await expect(create(input)).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
			expect(await intents()).toHaveLength(0);
			expect(await accountReservations()).toHaveLength(1);
		},
	);

	it("keeps actual single-file limits even for a paid unlimited account", async () => {
		const input = await seed("oversize", "account", 11_000_000);
		await subscription({});
		await expect(create(input)).rejects.toThrow("INPUT_TOO_LARGE");
		expect(await intents()).toHaveLength(0);
		expect(await accountReservations()).toHaveLength(0);
	});

	it("grants one lease under concurrent claims and fences stale commit and MPU registration", async () => {
		const { promotionId, p } = await prepared("lease");
		const claims = await Promise.all(
			Array.from({ length: 8 }, () => claimAccountInputCopy({ promotionId }, fixture.client())),
		);
		const old = claims.find(Boolean)!;
		expect(claims.filter(Boolean)).toHaveLength(1);
		await registerAccountInputCopyMultipart(
			{ ...old, multipartUploadId: "durable-mpu" },
			fixture.client(),
		);
		await expireLease(promotionId);
		const current = await claimAccountInputCopy({ promotionId }, fixture.client());
		expect(current).toMatchObject({ target: old.target, multipartUploadId: "durable-mpu" });
		expect(current?.leaseToken).not.toBe(old.leaseToken);
		await expect(commit(old)).rejects.toThrow("ACCOUNT_INPUT_COPY_LEASE_LOST");
		await expect(
			registerAccountInputCopyMultipart(
				{ ...old, multipartUploadId: "stale-mpu" },
				fixture.client(),
			),
		).rejects.toThrow("ACCOUNT_INPUT_COPY_LEASE_LOST");
		expect((await intent(promotionId)).multipartUploadId).toBe("durable-mpu");
		expect(await target(p.target.assetId)).toMatchObject({ status: "UPLOADING" });
		await commit(current!);
		expect(await target(p.target.assetId)).toMatchObject({ status: "VERIFYING" });
		await expect(commit(old)).rejects.toThrow("ACCOUNT_INPUT_COPY_LEASE_LOST");
	});

	it("materializes VERIFYING atomically and requires current target evidence before READY", async () => {
		const { input, promotionId, p } = await prepared("verify");
		const before = await sourceSnapshot(input.assetId);
		const claim = await claimAccountInputCopy({ promotionId }, fixture.client());
		await commit(claim!);
		expect(await target(p.target.assetId)).toMatchObject({
			status: "VERIFYING",
			checksum,
			verificationGeneration: 1,
			verificationAttemptCount: 0,
			storageEtag: "target-etag",
		});
		expect(
			await fixture.rows(`SELECT "assetId" FROM ${fixture.table("generation_draft")} WHERE id=$1`, [
				input.draftId,
			]),
		).toEqual([{ assetId: p.target.assetId }]);
		expect(await accountReservations()).toMatchObject([{ status: "COMMITTED", bytes: 100n }]);
		expect(
			await fixture.rows(
				`SELECT payload FROM ${fixture.table("outbox_event")} WHERE "eventType"='MEDIA_ASSET_VERIFY'`,
			),
		).toEqual([{ payload: { assetId: p.target.assetId } }]);
		expect(await status(input)).toMatchObject({ status: "VERIFYING" });
		await commit(claim!); // Lost-response replay must not create another target or verification event.
		expect(
			await fixture.rows(
				`SELECT id FROM ${fixture.table("outbox_event")} WHERE "eventType"='MEDIA_ASSET_VERIFY'`,
			),
		).toHaveLength(1);
		await approve(p.target.assetId, { evidenceGeneration: 0 });
		expect(await status(input)).toMatchObject({ status: "VERIFYING" });
		await fixture.rows(
			`UPDATE ${fixture.table("asset_moderation_result")} SET "verificationGeneration"=1 WHERE "assetId"=$1`,
			[p.target.assetId],
		);
		expect(await status(input)).toMatchObject({ status: "READY" });
		await fixture.transaction((tx) =>
			reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx),
		);
		expect((await intent(promotionId)).phase).toBe("READY");
		expect(await accountReservations()).toMatchObject([
			{ referenceKey: `media-draft:${p.target.assetId}`, status: "COMMITTED", bytes: 100n },
		]);
		expect(await claimAccountInputCopyOrphan({ promotionId }, fixture.client())).toBeNull();
		expect(await sourceSnapshot(input.assetId)).toEqual(before);
		await noCreditOrJobChanges();
	});

	it.each(["ownerId", "objectKey"])(
		"never exposes READY for a target whose %s no longer matches its immutable binding",
		async (field) => {
			const { input, promotionId, p } = await prepared(`wrong-${field}`);
			await commit((await claimAccountInputCopy({ promotionId }, fixture.client()))!);
			await approve(p.target.assetId);
			await fixture.rows(
				`UPDATE ${fixture.table("media_asset")} SET "${field}"='another-identity' WHERE id=$1`,
				[p.target.assetId],
			);
			expect((await status(input))?.status).not.toBe("READY");
		},
	);

	it.each([
		["assetChecksum", "b".repeat(64)],
		["providerTaskId", "another-task"],
		["ruleVersion", "another-rule"],
		["policyVersion", "another-policy"],
		["evidenceKind", "OUTPUT"],
		["validUntil", "2000-01-01T00:00:00.000Z"],
	])(
		"keeps a materialized target pending when its latest evidence %s is stale",
		async (field, value) => {
			const { input, promotionId, p } = await prepared(`evidence-${field}`);
			await commit((await claimAccountInputCopy({ promotionId }, fixture.client()))!);
			await approve(p.target.assetId);
			await fixture.rows(
				`UPDATE ${fixture.table("asset_moderation_result")} SET "${field}"=$2 WHERE "assetId"=$1`,
				[p.target.assetId, value],
			);
			expect((await status(input))?.status).not.toBe("READY");
			await fixture.transaction((tx) =>
				reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx),
			);
			expect((await intent(promotionId)).phase).toBe("VERIFYING");
		},
	);

	it.each([
		["byteSize", "200"],
		["mimeType", "image/jpeg"],
		["checksum", "b".repeat(64)],
	])(
		"rejects materialization replay and READY when target %s changes despite approval",
		async (field, value) => {
			const { input, promotionId, p } = await prepared(`target-${field}`);
			const claim = (await claimAccountInputCopy({ promotionId }, fixture.client()))!;
			await commit(claim);
			await approve(p.target.assetId);
			await fixture.rows(`UPDATE ${fixture.table("media_asset")} SET "${field}"=$2 WHERE id=$1`, [
				p.target.assetId,
				value,
			]);
			if (field === "checksum")
				await fixture.rows(
					`UPDATE ${fixture.table("asset_moderation_result")} SET "assetChecksum"=$2 WHERE "assetId"=$1`,
					[p.target.assetId, value],
				);
			expect((await status(input))?.status).not.toBe("READY");
			await expect(commit(claim)).rejects.toThrow("ACCOUNT_INPUT_COPY_BINDING_CHANGED");
		},
	);

	it.each(["delete", "checksum", "mime", "kind", "source-expiry", "draft-expiry"])(
		"rejects materialization after frozen source %s changes",
		async (change) => {
			const { input, promotionId, p } = await prepared(`source-${change}`);
			const claim = await claimAccountInputCopy({ promotionId }, fixture.client());
			if (change === "draft-expiry") {
				await fixture.rows(
					`UPDATE ${fixture.table("generation_draft")} SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,
					[input.draftId],
				);
			} else {
				const mutation = {
					delete: `status='DELETED',"deletedAt"=now()`,
					checksum: `checksum='${"b".repeat(64)}'`,
					mime: `"mimeType"='image/jpeg'`,
					kind: `kind='OUTPUT'`,
					"source-expiry": `"deleteAfter"=now()-interval '1 second'`,
				}[change];
				await fixture.rows(`UPDATE ${fixture.table("media_asset")} SET ${mutation} WHERE id=$1`, [
					p.source.assetId,
				]);
			}
			await expect(commit(claim!)).rejects.toThrow("ACCOUNT_INPUT_COPY_BINDING_CHANGED");
			expect(await target(p.target.assetId)).toMatchObject({ status: "UPLOADING", checksum: null });
			expect(await accountReservations()).toMatchObject([{ status: "ACTIVE" }]);
			await noCreditOrJobChanges();
		},
	);

	it("expires an in-flight business window without reviving the target or releasing uncertain physical bytes", async () => {
		const { input, promotionId, p } = await prepared("expired");
		const claim = await claimAccountInputCopy({ promotionId }, fixture.client());
		await fixture.rows(
			`UPDATE ${fixture.table("outbox_event")} SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE id=$1`,
			[promotionId],
		);
		await commit(claim!);
		expect(await target(p.target.assetId)).toMatchObject({ status: "DELETED" });
		expect(await status(input)).toMatchObject({ status: "EXPIRED" });
		await expect(commit(claim!)).rejects.toThrow("ACCOUNT_INPUT_COPY_LEASE_LOST");
		await recordAccountInputCopyOrphanPass({ promotionId }, fixture.client());
		expect(await accountReservations()).toMatchObject([{ status: "ACTIVE" }]);
		expect(await claimAccountInputCopyOrphan({ promotionId }, fixture.client())).toMatchObject({
			objectKey: p.target.objectKey,
		});
	});
	it("continues to count an expired uncertain writer through the real upload/generation storage filter", async () => {
		const { promotionId, p } = await prepared("expired-quota-usage");
		const claim = await claimAccountInputCopy({ promotionId }, fixture.client());
		await registerAccountInputCopyMultipart(
			{ ...claim!, multipartUploadId: "still-unknown" },
			fixture.client(),
		);
		await fixture.rows(
			`UPDATE ${fixture.table("storage_usage_reservation")} SET "expiresAt"=now()-interval '1 day' WHERE "referenceKey"=$1`,
			[`account-input-copy:${p.target.assetId}`],
		);
		await fixture.rows(
			`UPDATE ${fixture.table("outbox_event")} SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE id=$1`,
			[promotionId],
		);
		await commit(claim!);
		await recordAccountInputCopyOrphanPass({ promotionId }, fixture.client());
		const actualUsage = () =>
			fixture.transaction((tx) =>
				tx.storageUsageReservation.aggregate({
					where: {
						ownerType: "USER",
						ownerId: "account",
						status: { in: ["ACTIVE", "COMMITTED"] },
						...unexpiredStorageReservations(new Date()),
					},
					_sum: { bytes: true },
				}),
			);
		expect(await actualUsage()).toEqual({ _sum: { bytes: 100n } });
		await reserve("account", 900n, "other-account-bytes");
		expect(await actualUsage()).toEqual({ _sum: { bytes: 1_000n } });
		const next = await seed("quota-after-unknown-expiry", "account", 1);
		await expect(create(next)).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
		expect(await intents()).toHaveLength(1);
		await noCreditOrJobChanges();
	});
	it("releases a never-started expired copy only after its terminal cleanup pass", async () => {
		const { promotionId } = await prepared("never-started-expiry");
		await fixture.rows(
			`UPDATE ${fixture.table("storage_usage_reservation")} SET "expiresAt"=now()-interval '1 day' WHERE "ownerId"='account'`,
		);
		await fixture.rows(
			`UPDATE ${fixture.table("outbox_event")} SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE id=$1`,
			[promotionId],
		);
		expect(await claimAccountInputCopy({ promotionId }, fixture.client())).toBeNull();
		expect(await accountReservations()).toMatchObject([{ status: "ACTIVE" }]);
		await recordAccountInputCopyOrphanPass({ promotionId }, fixture.client());
		expect(await accountReservations()).toMatchObject([{ status: "RELEASED" }]);
		expect((await intent(promotionId)).phase).toBe("CLEANED");
		await noCreditOrJobChanges();
	});

	it("retains terminal orphan recovery and reservations after a cleanup pass when a late writer remains possible", async () => {
		const { input, promotionId, p } = await prepared("late-writer");
		const old = (await claimAccountInputCopy({ promotionId }, fixture.client()))!;
		await registerAccountInputCopyMultipart(
			{ ...old, multipartUploadId: "late-mpu" },
			fixture.client(),
		);
		await failAccountInputCopy(
			{ ...old, reasonCode: "COPY_IDENTITY_INVALID", definitive: true },
			fixture.client(),
		);
		expect(await status(input)).toMatchObject({ status: "FAILED" });
		await expect(commit(old)).rejects.toThrow("ACCOUNT_INPUT_COPY_LEASE_LOST");
		expect(
			await fixture.transaction((tx) =>
				reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx),
			),
		).toEqual({ terminal: true });
		expect(await claimAccountInputCopyOrphan({ promotionId }, fixture.client())).toMatchObject({
			objectKey: p.target.objectKey,
			multipartUploadId: "late-mpu",
		});
		await recordAccountInputCopyOrphanPass({ promotionId }, fixture.client());
		expect(await accountReservations()).toMatchObject([{ status: "ACTIVE" }]);
		await due(promotionId);
		expect(await recoverAccountInputCopies({}, fixture.client())).toMatchObject({
			orphanIds: [promotionId],
		});
		await recordAccountInputCopyOrphanPass({ promotionId }, fixture.client());
		await due(promotionId);
		expect(await recoverAccountInputCopies({}, fixture.client())).toMatchObject({
			orphanIds: [promotionId],
		});
		expect(
			await fixture.rows(
				`SELECT "dedupeKey" FROM ${fixture.table("outbox_event")} WHERE "eventType"='ACCOUNT_INPUT_COPY_ORPHAN_CHECK'`,
			),
		).toHaveLength(3);
		expect(await target(p.target.assetId)).toMatchObject({ status: "DELETED" });
		await noCreditOrJobChanges();
	});

	it("keeps an unknown old writer accounted after READY and normal target deletion, then repeats exact-key orphan recovery", async () => {
		const { input, promotionId, p } = await prepared("ready-late-writer");
		const old = (await claimAccountInputCopy({ promotionId }, fixture.client()))!;
		await expireLease(promotionId);
		const current = (await claimAccountInputCopy({ promotionId }, fixture.client()))!;
		await commit(current);
		await approve(p.target.assetId);
		await fixture.transaction((tx) =>
			reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx),
		);
		expect(await status(input)).toMatchObject({ status: "READY" });
		expect(await accountReservations()).toMatchObject([
			{ referenceKey: `account-input-copy:${p.target.assetId}`, status: "COMMITTED", bytes: 100n },
		]);
		await fixture.rows(
			`UPDATE ${fixture.table("media_asset")} SET status='DELETED',"deletedAt"=now() WHERE id=$1`,
			[p.target.assetId],
		);
		await due(promotionId);
		await recoverAccountInputCopies({}, fixture.client());
		expect(await status(input)).toMatchObject({ status: "FAILED" });
		await expect(commit(old)).rejects.toThrow("ACCOUNT_INPUT_COPY_LEASE_LOST");
		for (let pass = 0; pass < 2; pass++) {
			expect(await claimAccountInputCopyOrphan({ promotionId }, fixture.client())).toMatchObject({
				objectKey: p.target.objectKey,
			});
			await recordAccountInputCopyOrphanPass({ promotionId }, fixture.client());
			await due(promotionId);
			expect(await recoverAccountInputCopies({}, fixture.client())).toMatchObject({
				orphanIds: [promotionId],
			});
			expect(await accountReservations()).toMatchObject([{ status: "COMMITTED" }]);
		}
		await noCreditOrJobChanges();
	});

	it("preserves destination and reservation through transient failure and fences the old worker", async () => {
		const { promotionId } = await prepared("retry");
		const old = (await claimAccountInputCopy({ promotionId }, fixture.client()))!;
		await registerAccountInputCopyMultipart(
			{ ...old, multipartUploadId: "resume-mpu" },
			fixture.client(),
		);
		await failAccountInputCopy(
			{ ...old, reasonCode: "STORAGE_TIMEOUT", definitive: false },
			fixture.client(),
		);
		const next = await claimAccountInputCopy({ promotionId }, fixture.client());
		expect(next).toMatchObject({ target: old.target, multipartUploadId: "resume-mpu" });
		await expect(commit(old)).rejects.toThrow("ACCOUNT_INPUT_COPY_LEASE_LOST");
		expect(await accountReservations()).toHaveLength(1);
		expect(await accountReservations()).toMatchObject([{ status: "ACTIVE" }]);
	});

	it.each(["commit", "terminal"])(
		"serializes %s first against the opposing draft-row waiter",
		async (first) => {
			const { input, promotionId, p } = await prepared(`race-${first}`);
			const claim = (await claimAccountInputCopy({ promotionId }, fixture.client()))!;
			const holder = await holdDraft(input.draftId);
			const operations = {
				commit: () => commit(claim),
				terminal: () =>
					failAccountInputCopy(
						{ ...claim, reasonCode: "COPY_FAILED", definitive: true },
						fixture.client(),
					),
			};
			const second = first === "commit" ? "terminal" : "commit";
			let left!: Promise<PromiseSettledResult<void>>;
			let right!: Promise<PromiseSettledResult<void>>;
			try {
				left = settled(operations[first as keyof typeof operations]());
				await waitForLockWaiters(1);
				right = settled(operations[second]());
				await waitForLockWaiters(2);
			} finally {
				await holder.release();
			}
			expect(await left).toMatchObject({ status: "fulfilled" });
			expect(await right).toMatchObject({
				status: "rejected",
				reason: { message: "ACCOUNT_INPUT_COPY_LEASE_LOST" },
			});
			if (first === "commit") {
				expect(await target(p.target.assetId)).toMatchObject({
					status: "VERIFYING",
					deletedAt: null,
				});
				expect(await accountReservations()).toMatchObject([{ status: "COMMITTED" }]);
				expect(await claimAccountInputCopyOrphan({ promotionId }, fixture.client())).toBeNull();
			} else {
				expect(await target(p.target.assetId)).toMatchObject({ status: "DELETED" });
				expect(await accountReservations()).toMatchObject([{ status: "ACTIVE" }]);
				expect(await claimAccountInputCopyOrphan({ promotionId }, fixture.client())).toMatchObject({
					objectKey: p.target.objectKey,
				});
			}
			await noCreditOrJobChanges();
		},
	);

	it("recovery does not deadlock a standard verifier already holding the target asset row", async () => {
		const { promotionId, p } = await prepared("verify-lock-order");
		await commit((await claimAccountInputCopy({ promotionId }, fixture.client()))!);
		await approve(p.target.assetId);
		let continueVerifier!: () => void;
		let assetLocked!: () => void;
		const locked = new Promise<void>((resolve) => {
			assetLocked = resolve;
		});
		const proceed = new Promise<void>((resolve) => {
			continueVerifier = resolve;
		});
		const verifier = fixture.transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM "media_asset" WHERE id=${p.target.assetId} FOR UPDATE`;
			assetLocked();
			await proceed;
			return reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx);
		});
		await locked;
		const recovery = settled(recoverAccountInputCopies({}, fixture.client()));
		try {
			await waitForLockWaiters(1);
		} finally {
			continueVerifier();
		}
		expect(await verifier).toEqual({ terminal: false });
		expect(await recovery).toMatchObject({ status: "fulfilled" });
		expect((await intent(promotionId)).phase).toBe("READY");
	});

	it("leaves ordinary INPUT approval untouched and never queries root intents without a target pointer", async () => {
		const input = await seed("ordinary-input");
		const before = await sourceSnapshot(input.assetId);
		const evidenceBefore = await fixture.rows(
			`SELECT * FROM ${fixture.table("asset_moderation_result")} WHERE "assetId"=$1`,
			[input.assetId],
		);
		await fixture.transaction(async (tx) => {
			const queries = vi.spyOn(tx, "$queryRaw");
			expect(
				await reconcileAccountInputCopyTargetInTransaction({ assetId: input.assetId }, tx),
			).toEqual({ terminal: false });
			expect(
				queries.mock.calls.some((call: unknown[]) =>
					call.slice(1).includes("ACCOUNT_INPUT_COPY_INTENT"),
				),
			).toBe(false);
			expect(queries.mock.calls.some((call: unknown[]) => String(call[0]).includes("#>>"))).toBe(
				false,
			);
		});
		expect(await sourceSnapshot(input.assetId)).toEqual(before);
		expect(await target(input.assetId)).toMatchObject({ status: "READY" });
		expect(
			await fixture.rows(
				`SELECT * FROM ${fixture.table("asset_moderation_result")} WHERE "assetId"=$1`,
				[input.assetId],
			),
		).toEqual(evidenceBefore);
		await noCreditOrJobChanges();
	});

	it("rejects a pointer to another target without mutating either journal or reservation", async () => {
		const first = await prepared("pointer-first");
		const second = await prepared("pointer-second");
		await fixture.rows(
			`UPDATE ${fixture.table("outbox_event")} SET payload=$2::jsonb WHERE "dedupeKey"=$1`,
			[
				`account-input-copy-target:${second.p.target.assetId}`,
				JSON.stringify({ promotionId: first.promotionId }),
			],
		);
		const before = {
			intents: await intents(),
			reserves: await accountReservations(),
			first: await target(first.p.target.assetId),
			second: await target(second.p.target.assetId),
		};
		await expect(
			fixture.transaction((tx) =>
				reconcileAccountInputCopyTargetInTransaction({ assetId: second.p.target.assetId }, tx),
			),
		).rejects.toThrow("ACCOUNT_INPUT_COPY_INTENT_INVALID");
		expect({
			intents: await intents(),
			reserves: await accountReservations(),
			first: await target(first.p.target.assetId),
			second: await target(second.p.target.assetId),
		}).toEqual(before);
		await noCreditOrJobChanges();
	});

	it("moves examined unresolved intents behind other due work instead of starving it", async () => {
		const oldest = await prepared("oldest-orphan");
		const oldClaim = (await claimAccountInputCopy(
			{ promotionId: oldest.promotionId },
			fixture.client(),
		))!;
		await failAccountInputCopy(
			{ ...oldClaim, reasonCode: "COPY_FAILED", definitive: true },
			fixture.client(),
		);
		const waiting = await prepared("waiting-source");
		await fixture.rows(
			`UPDATE ${fixture.table("media_asset")} SET status='VERIFYING' WHERE id=$1`,
			[waiting.p.source.assetId],
		);
		const newest = await prepared("newest-runnable");
		// Make FIFO order independent of UUID ordering and wall-clock resolution.
		for (const [index, promotionId] of [
			oldest.promotionId,
			waiting.promotionId,
			newest.promotionId,
		].entries()) {
			await fixture.rows(
				`UPDATE ${fixture.table("outbox_event")} SET "createdAt"=now()-interval '1 hour'+$2::int*interval '1 second',"availableAt"=now()-interval '1 hour'+$2::int*interval '1 second' WHERE id=$1`,
				[promotionId, index],
			);
		}
		const seen = new Set<string>();
		for (let pass = 0; pass < 3; pass++) {
			const result = await recoverAccountInputCopies({ limit: 1 }, fixture.client());
			for (const id of [...result.promotionIds, ...result.orphanIds]) seen.add(id);
		}
		expect(seen).toEqual(new Set([oldest.promotionId, waiting.promotionId, newest.promotionId]));
		expect(
			await claimAccountInputCopyOrphan({ promotionId: newest.promotionId }, fixture.client()),
		).toBeNull();
	});

	it("rolls back target, intent and reservation when publishing fails, leaving credits and source untouched", async () => {
		const input = await seed("rollback");
		const before = await sourceSnapshot(input.assetId);
		await fixture.rows(
			`CREATE FUNCTION "${fixture.schema}".reject_copy_publication() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN IF NEW."eventType"='ACCOUNT_INPUT_COPY_REQUESTED' THEN RAISE EXCEPTION 'INJECTED_PUBLICATION_FAILURE'; END IF; RETURN NEW; END $body$`,
		);
		await fixture.rows(
			`CREATE TRIGGER reject_copy_publication BEFORE INSERT ON ${fixture.table("outbox_event")} FOR EACH ROW EXECUTE FUNCTION "${fixture.schema}".reject_copy_publication()`,
		);
		try {
			await expect(create(input)).rejects.toThrow("INJECTED_PUBLICATION_FAILURE");
		} finally {
			await fixture.rows(
				`DROP TRIGGER reject_copy_publication ON ${fixture.table("outbox_event")}`,
			);
		}
		expect(await intents()).toHaveLength(0);
		expect(
			await fixture.rows(
				`SELECT id FROM ${fixture.table("media_asset")} WHERE "retentionClass"='ACCOUNT'`,
			),
		).toHaveLength(0);
		expect(await accountReservations()).toHaveLength(0);
		expect(await sourceSnapshot(input.assetId)).toEqual(before);
		await noCreditOrJobChanges();
	});
});

async function seed(name: string, ownerId = "account", bytes = 100) {
	const assetId = `source-${name}`,
		draftId = `draft-${name}`;
	await fixture.rows(
		`INSERT INTO ${fixture.table("user")} VALUES ($1,false),('guest',true) ON CONFLICT DO NOTHING`,
		[ownerId],
	);
	await fixture.rows(
		`INSERT INTO ${fixture.table("media_asset")} (id,"ownerType","ownerId",kind,status,"retentionClass","objectKey","mimeType","byteSize",checksum,"deleteAfter") VALUES ($1,'USER','guest','INPUT','VERIFYING','GUEST_TRIAL',$2,'image/png',$3,$4,now()+interval '1 hour')`,
		[assetId, `guests/guest/${assetId}.png`, bytes, checksum],
	);
	await approve(assetId);
	await fixture.rows(
		`INSERT INTO ${fixture.table("generation_draft")} (id,"ownerId","submittedByUserId","assetId","productKey",status,"expiresAt") VALUES ($1,$2,$2,$3,'image-nano-banana','SUBMITTED',now()+interval '1 hour')`,
		[draftId, ownerId, assetId],
	);
	await reserve("guest", BigInt(bytes), `media-draft:${draftId}`);
	await fixture.rows(
		`INSERT INTO ${fixture.table("outbox_event")} (id,"eventType","aggregateType","aggregateId","dedupeKey",payload) VALUES ($1,'MEDIA_ASSET_DELETE_REQUESTED','MEDIA_ASSET',$2,$3,$4::jsonb)`,
		[
			randomUUID(),
			assetId,
			`guest-cleanup:${assetId}`,
			JSON.stringify({ assetId, objectKey: `guests/guest/${assetId}.png` }),
		],
	);
	return { draftId, previousOwnerId: "guest", nextOwnerId: ownerId, assetId };
}
type CopyInput = Awaited<ReturnType<typeof seed>>;
async function create(input: CopyInput) {
	return fixture.transaction(async (tx) => {
		// The production helper's documented caller contract holds the draft row.
		await tx.$queryRaw`SELECT id FROM "generation_draft" WHERE id=${input.draftId} FOR UPDATE`;
		return createAccountInputCopyInTransaction(input, tx);
	});
}
async function prepared(name: string) {
	const input = await seed(name);
	await create(input);
	const row = (
		await fixture.rows(
			`SELECT id,payload FROM ${fixture.table("outbox_event")} WHERE "dedupeKey"=$1`,
			[`account-input-copy:v1:${input.draftId}`],
		)
	)[0]!;
	return { input, promotionId: String(row.id), p: parseAccountInputCopyIntent(row.payload) };
}
async function intents() {
	return fixture.rows(
		`SELECT id,payload FROM ${fixture.table("outbox_event")} WHERE "eventType"='ACCOUNT_INPUT_COPY_INTENT' ORDER BY id`,
	);
}
async function intent(id: string) {
	return parseAccountInputCopyIntent(
		(
			await fixture.rows(`SELECT payload FROM ${fixture.table("outbox_event")} WHERE id=$1`, [id])
		)[0]?.payload,
	);
}
async function target(id: string) {
	return (await fixture.rows(`SELECT * FROM ${fixture.table("media_asset")} WHERE id=$1`, [id]))[0];
}
async function status(input: CopyInput) {
	return getAccountInputCopyStatus(
		{ ownerId: input.nextOwnerId, draftId: input.draftId },
		fixture.client(),
	);
}
async function accountReservations() {
	return fixture.rows(
		`SELECT * FROM ${fixture.table("storage_usage_reservation")} WHERE "ownerId"='account' ORDER BY "referenceKey"`,
	);
}
async function reserve(owner: string, bytes: bigint, reference: string) {
	await fixture.rows(
		`INSERT INTO ${fixture.table("storage_usage_reservation")} (id,"ownerType","ownerId",bytes,"referenceKey",status,"expiresAt") VALUES ($1,'USER',$2,$3,$4,'ACTIVE',now()+interval '1 hour')`,
		[randomUUID(), owner, bytes, reference],
	);
}
async function sourceSnapshot(id: string) {
	return {
		asset: await target(id),
		reservations: await fixture.rows(
			`SELECT * FROM ${fixture.table("storage_usage_reservation")} WHERE "ownerId"='guest' ORDER BY id`,
		),
		cleanup: await fixture.rows(
			`SELECT * FROM ${fixture.table("outbox_event")} WHERE "eventType"='MEDIA_ASSET_DELETE_REQUESTED' ORDER BY id`,
		),
	};
}
async function noCreditOrJobChanges() {
	for (const name of ["credit_ledger_entry", "credit_reservation", "generation_job"])
		expect(await fixture.rows(`SELECT * FROM ${fixture.table(name)}`)).toEqual([]);
	expect(await fixture.rows(`SELECT * FROM ${fixture.table("credit_account")}`)).toEqual([
		{ id: "untouched", spendableCredits: 19n, reservedCredits: 3n },
	]);
}
async function approve(
	assetId: string,
	{ evidenceGeneration = 1, verificationGeneration = 1, attemptNumber = 1 } = {},
) {
	const validUntil = new Date(Date.now() + 3_600_000),
		providerTaskId = `review-${assetId}`;
	await fixture.rows(
		`UPDATE ${fixture.table("media_asset")} SET status='READY',"verificationGeneration"=$4,"verificationAttemptCount"=$5,"verificationProvider"='seeapi',"verificationProviderTaskId"=$2,"verificationRuleVersion"='image-v1',"verificationPolicyVersion"='safe-v1',"verificationValidUntil"=$3 WHERE id=$1`,
		[assetId, providerTaskId, validUntil, verificationGeneration, attemptNumber],
	);
	await fixture.rows(
		`INSERT INTO ${fixture.table("asset_moderation_result")} (id,"assetId",status,"reasonCode","assetChecksum","verificationGeneration","attemptNumber","evidenceKind",provider,"providerTaskId","ruleVersion","policyVersion","validUntil") VALUES ($1,$2,'APPROVED','APPROVED',$3,$4,$7,'INPUT','seeapi',$5,'image-v1','safe-v1',$6)`,
		[
			randomUUID(),
			assetId,
			checksum,
			evidenceGeneration,
			providerTaskId,
			validUntil,
			attemptNumber,
		],
	);
}
async function review(assetId: string, decision = "REVIEW") {
	const providerTaskId = `content-review-${assetId}`;
	await fixture.rows(
		`UPDATE ${fixture.table("media_asset")} SET status='QUARANTINED',"verificationGeneration"=1,"verificationAttemptCount"=2,"verificationProvider"='seeapi',"verificationProviderTaskId"=$2,"verificationRuleVersion"='image-v1',"verificationPolicyVersion"='safe-v1',"verificationValidUntil"=NULL WHERE id=$1`,
		[assetId, providerTaskId],
	);
	await fixture.rows(
		`INSERT INTO ${fixture.table("asset_moderation_result")} (id,"assetId",status,"reasonCode","assetChecksum","verificationGeneration","attemptNumber","evidenceKind",provider,"providerTaskId","ruleVersion","policyVersion","validUntil") VALUES ($1,$2,$5,'SEEAPI_CONTENT_REVIEW',$3,1,2,'INPUT','seeapi',$4,'image-v1','safe-v1',NULL)`,
		[randomUUID(), assetId, checksum, providerTaskId, decision],
	);
}
async function commit(claim: NonNullable<Awaited<ReturnType<typeof claimAccountInputCopy>>>) {
	return commitAccountInputCopy(
		{
			promotionId: claim.promotionId,
			leaseToken: claim.leaseToken,
			checksum: claim.source.checksum,
			bytes: claim.source.bytes,
			mimeType: claim.source.mimeType,
			storageEtag: "target-etag",
		},
		fixture.client(),
	);
}
async function expireLease(id: string) {
	await fixture.rows(
		`UPDATE ${fixture.table("outbox_event")} SET payload=jsonb_set(payload,'{leasedUntil}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE id=$1`,
		[id],
	);
}
async function due(id: string) {
	await fixture.rows(
		`UPDATE ${fixture.table("outbox_event")} SET "availableAt"=now()-interval '1 hour' WHERE id=$1`,
		[id],
	);
}
async function waitForAdvisoryWaiters(count: number) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const [row] = await fixture.rows(
			`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'`,
			[fixture.schema],
		);
		if (row?.count >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`EXPECTED_${count}_REAL_POSTGRES_ADVISORY_WAITERS`);
}
async function waitForLockWaiters(count: number) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const [row] = await fixture.rows(
			`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`,
			[fixture.schema],
		);
		if (row?.count >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`EXPECTED_${count}_REAL_POSTGRES_ROW_WAITERS`);
}
async function holdDraft(id: string) {
	let unlock!: () => void;
	let locked!: () => void;
	const ready = new Promise<void>((resolve) => {
		locked = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		unlock = resolve;
	});
	const holder = fixture.transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM "generation_draft" WHERE id=${id} FOR UPDATE`;
		locked();
		await gate;
	});
	await ready;
	return {
		release: async () => {
			unlock();
			await holder;
		},
	};
}
function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
	return promise.then(
		(value) => ({ status: "fulfilled", value }),
		(reason) => ({ status: "rejected", reason }),
	);
}
async function subscription({
	status = "ACTIVE",
	state = "paid",
}: {
	status?: string;
	state?: string;
}) {
	const start = new Date(Date.now() - 3_600_000),
		end = new Date(Date.now() + (state === "expired" ? -1000 : 3_600_000));
	await fixture.rows(
		`INSERT INTO ${fixture.table("plan")} VALUES ('creator','Creator','{"planId":"creator"}'::jsonb,'IMAGE')`,
	);
	await fixture.rows(
		`INSERT INTO ${fixture.table("subscription")} (id,"planId",provider,"ownerType","ownerId",status,"refundTerminationRequestedAt","currentPeriodStart","currentPeriodEnd","graceEndsAt") VALUES ('subscription','creator','stripe','USER','account',$1,$2,$3,$4,$5)`,
		[status, state === "terminating" ? start : null, start, end, end],
	);
	await fixture.rows(
		`INSERT INTO ${fixture.table("billing_period")} (id,"subscriptionId","startsAt","endsAt","paidAmount","refundedAmount",status,"providerInvoiceId") VALUES ('period','subscription',$1,$2,1000,$3,'ACTIVE','invoice')`,
		[start, end, state === "refunded" ? 1000 : 0],
	);
}
