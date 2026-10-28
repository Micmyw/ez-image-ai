import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	TestMediaSafetyAdapter,
} from "@repo/ai";
import type { MediaAsset } from "@repo/database/generated-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	reconcileCopy: vi.fn(async () => ({ terminal: false })),
	recordOutcome: vi.fn(async () => undefined),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", async (original) => ({
	...(await original<Record<string, unknown>>()),
	recordLockedAssetModerationOutcome: mocks.recordOutcome,
}));
vi.mock("@repo/database/media-account-input-copy", async (original) => ({
	...(await original<Record<string, unknown>>()),
	reconcileAccountInputCopyTargetInTransaction: mocks.reconcileCopy,
}));

import { createDatabaseVerifyUploadDependencies } from "../runtime";

function fixture(kind: "INPUT" | "OUTPUT" = "OUTPUT") {
	const now = new Date("2026-10-22T10:00:00.000Z");
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	const owner = { workflowId: "workflow-review", phaseKey: "phase-review", epoch: 3 };
	const asset = {
		id: "review-asset",
		ownerType: "USER",
		ownerId: "owner",
		kind,
		status: "VERIFYING",
		deletedAt: null,
		objectKey: "users/owner/assets/review-asset/original.png",
		mimeType: "image/png",
		byteSize: 16n,
		checksum: "a".repeat(64),
		storageEtag: "etag",
		storageVersionId: "v1",
		finalizedAt: now,
		outputTransferToken: null,
		deleteAfter: null,
		verificationEngine: "legacy",
		verificationGeneration: 1,
		verificationAttemptCount: 1,
		verificationProvider: "seeapi",
		verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		verificationProviderTaskId: "bound-task",
		verificationLeaseToken: null,
		verificationLeasedUntil: null,
		verificationNextAttemptAt: null,
		verificationDeadlineAt: new Date(now.getTime() + 120_000),
		verificationValidUntil: null,
		verificationSubmissionToken: "submission-proof",
		verificationSubmissionUncertain: false,
		verificationCallbackReceivedAt: now,
		verificationLastErrorCode: "IMAGE_PROCESSING",
	} as MediaAsset;
	const state = {
		owner: { ...owner, leasedUntil: new Date(now.getTime() + 600_000) },
		providerGate: true,
		hasCopy: false,
		legacyMarker: false,
		failures: 0,
		previous: null as null | { id: string; lastErrorCode: string; lastFailureAt: Date },
		adminRejected: false,
	};
	const evidence: Array<Record<string, unknown>> = [];
	const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
		...Object.assign(asset, data),
	}));
	const count = vi.fn(async () => state.failures);
	const findUnique = vi.fn(async () => ({ ...asset }));
	const query = vi.fn(async (sql: TemplateStringsArray) => {
		const statement = sql.join("?");
		if (statement.includes('AS "hasLegacyReverificationMarker"')) {
			if (asset.verificationEngine !== "legacy") return [];
			return [
				{
					...asset,
					phaseKey: state.owner.phaseKey,
					workflowId: state.owner.workflowId,
					epoch: state.owner.epoch,
					hasAccountInputCopy: state.hasCopy,
					hasLegacyReverificationMarker: state.legacyMarker,
					failureCount: state.failures,
				},
			];
		}
		if (statement.includes('AS "previousReviewId"'))
			return [
				{
					...asset,
					previousReviewId: state.previous?.id ?? null,
					previousLastErrorCode: state.previous?.lastErrorCode ?? null,
					previousLastFailureAt: state.previous?.lastFailureAt ?? null,
					hasAccountInputCopy: state.hasCopy,
					failureCount: state.failures,
					phaseOwnerCurrent: state.providerGate && state.owner.epoch === owner.epoch,
				},
			];
		if (statement.includes('clock_timestamp() AS "now"'))
			return [{ ...state.owner, now: new Date() }];
		if (statement.includes('RETURNING "verificationSubmissionToken"')) {
			asset.verificationSubmissionToken ??= "fresh-submission-proof";
			asset.verificationSubmissionUncertain = true;
			return [{ verificationSubmissionToken: asset.verificationSubmissionToken }];
		}
		if (statement.includes('AS "ownerCurrent"')) {
			asset.verificationProviderTaskId = "fresh-task";
			asset.verificationSubmissionUncertain = false;
			return [
				{
					verificationLeasedUntil: asset.verificationLeasedUntil,
					ownerCurrent: state.providerGate,
				},
			];
		}
		if (statement.includes('AS "current"')) return [{ current: state.providerGate }];
		if (statement.includes('SELECT "phaseKey"')) return [state.owner];
		if (statement.includes("FOR NO KEY UPDATE OF job")) return [];
		throw new Error(`UNEXPECTED_REVIEW_SQL:${statement}`);
	});
	const tx = {
		$queryRaw: query,
		$executeRaw: vi.fn(async () => 1),
		mediaAsset: {
			findUnique,
			findUniqueOrThrow: findUnique,
			findFirst: vi.fn(async () => ({ ...asset })),
			update,
			updateMany: vi.fn(async (input: { data: Record<string, unknown> }) => {
				await update(input);
				return { count: 1 };
			}),
		},
		assetModerationResult: {
			count,
			createMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				evidence.push(data);
				if (data.status === "ERROR") state.failures++;
				return { count: 1 };
			}),
		},
		auditLog: { findFirst: vi.fn(async () => (state.legacyMarker ? { id: "legacy" } : null)) },
		moderationReview: {
			findUnique: vi.fn(async () => state.previous),
			findFirst: vi.fn(async () => (state.adminRejected ? { id: "admin-review" } : null)),
		},
		generationJobAsset: {
			findMany: vi.fn(async (input: { select?: unknown }) =>
				input.select && state.adminRejected ? [{ job: { quoteId: "quote" } }] : [],
			),
		},
	};
	const db = {
		...tx,
		$transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
			operation(tx),
		),
	};
	const submit = vi.fn();
	const retrieve = vi.fn(async () => ({
		decision: "ALLOW" as const,
		reasonCode: "NO_POLICY_MATCH",
		ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
	}));
	const sign = vi.fn(async () => "https://private.invalid/signed");
	const inspect = vi.fn(async () => ({
		bytes: 16,
		sha256: asset.checksum!,
		etag: "etag",
		versionId: "v1",
	}));
	const dependencies = createDatabaseVerifyUploadDependencies(db as never, {
		moderationProvider: "seeapi",
		safety: Object.assign(new TestMediaSafetyAdapter("ERROR"), {
			submitImage: submit,
			retrieveImage: retrieve,
		}),
		createSignedReadUrl: sign,
		inspectPrivateMediaObject: inspect,
		headObject: async () => ({
			contentLength: 16,
			contentType: "image/png",
			etag: "etag",
			metadata: {},
		}),
		readMediaHeader: async () => Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		onVerificationError: (error) => {
			throw error;
		},
	});
	const run = (queryOnly = true) =>
		dependencies.verify(asset.id, {
			...(queryOnly ? { queryOnly: true } : {}),
			workflowId: owner.workflowId,
			phaseOwner: owner,
			admission: { asset: { ...asset } },
		});
	return {
		asset,
		state,
		owner,
		tx,
		db,
		update,
		query,
		count,
		findUnique,
		evidence,
		submit,
		retrieve,
		sign,
		inspect,
		run,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.reconcileCopy.mockResolvedValue({ terminal: false });
});
afterEach(() => vi.useRealTimers());

describe("current-transaction verification projections", () => {
	it.each(["INPUT", "OUTPUT"] as const)(
		"starts one fresh %s submission using the locked snapshot without duplicate absence reads",
		async (kind) => {
			const f = fixture(kind);
			Object.assign(f.asset, {
				verificationProviderTaskId: null,
				verificationSubmissionToken: null,
				verificationAttemptCount: 0,
				verificationLastErrorCode: null,
			});
			f.submit.mockImplementation(async (input: { idempotencyKey: string }) => ({
				moderationTaskId: "fresh-task",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				idempotency: { key: input.idempotencyKey },
			}));
			expect(await f.run(false)).toMatchObject({ verificationCommit: { status: "READY" } });
			expect(f.submit).toHaveBeenCalledOnce();
			expect(f.retrieve).toHaveBeenCalledOnce();
			expect(f.evidence).toHaveLength(1);
			expect(f.evidence[0]).toMatchObject({ status: "APPROVED", providerTaskId: "fresh-task" });
			expect(f.findUnique).not.toHaveBeenCalled();
			expect(f.count).not.toHaveBeenCalled();
			expect(f.tx.auditLog.findFirst).not.toHaveBeenCalled();
			expect(mocks.reconcileCopy).not.toHaveBeenCalled();
		},
	);

	it.each(["INPUT", "OUTPUT"] as const)(
		"commits %s approval without repeated absence/evidence reads or a new submission",
		async (kind) => {
			const f = fixture(kind);
			expect(await f.run()).toMatchObject({
				verificationCommit: { status: "READY", eventIds: [] },
			});
			expect(f.asset.status).toBe("READY");
			expect(f.evidence).toHaveLength(1);
			expect(f.evidence[0]).toMatchObject({
				status: "APPROVED",
				providerTaskId: "bound-task",
				verificationGeneration: 1,
			});
			expect(f.findUnique).not.toHaveBeenCalled();
			expect(f.count).not.toHaveBeenCalled();
			expect(f.tx.auditLog.findFirst).not.toHaveBeenCalled();
			expect(f.tx.moderationReview.findUnique).not.toHaveBeenCalled();
			expect(mocks.reconcileCopy).not.toHaveBeenCalled();
			expect(f.retrieve).toHaveBeenCalledOnce();
			expect(f.submit).not.toHaveBeenCalled();
			expect(f.sign).not.toHaveBeenCalled();
			expect(
				f.query.mock.calls.filter(([sql]) => sql.join("?").includes('AS "current"')),
			).toHaveLength(1);
		},
	);

	it("reports the failed verdict stage without replaying retrieval or logging private errors", async () => {
		const f = fixture();
		const error = Object.assign(
			new Error("private SQL and credentials must stay out of diagnostics"),
			{ code: "P2028" },
		);
		mocks.recordOutcome.mockRejectedValueOnce(error);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await expect(f.run()).rejects.toBe(error);
			expect(f.retrieve).toHaveBeenCalledOnce();
			expect(f.submit).not.toHaveBeenCalled();
			expect(f.evidence).toHaveLength(0);
			expect(f.asset.status).toBe("VERIFYING");
			expect(f.asset.verificationProviderTaskId).toBe("bound-task");
			expect(warn).toHaveBeenCalledExactlyOnceWith("media.upload.verification", {
				assetId: f.asset.id,
				generation: 1,
				stage: "verdict_transaction_failed",
				transactionStage: "moderation_outcome",
				elapsedMs: 0,
				timeoutMs: 20_000,
				errorCode: "P2028",
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("does not append approval after the owner changes during provider retrieval", async () => {
		const f = fixture();
		f.retrieve.mockImplementationOnce(async () => {
			f.state.owner.epoch++;
			f.state.providerGate = false;
			return {
				decision: "ALLOW",
				reasonCode: "NO_POLICY_MATCH",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			};
		});
		expect(await f.run()).toMatchObject({ phaseOwnershipLost: true });
		expect(f.evidence).toHaveLength(0);
		expect(f.asset.status).toBe("VERIFYING");
		expect(f.submit).not.toHaveBeenCalled();
	});

	it.each([
		["unknown submission", { verificationSubmissionUncertain: true }],
		["missing task", { verificationProviderTaskId: null }],
		["wrong generation", { verificationGeneration: 0 }],
		["wrong rules", { verificationRuleVersion: "old" }],
		["wrong policy", { verificationPolicyVersion: "old" }],
		["wrong provider", { verificationProvider: "old" }],
		["other engine", { verificationEngine: "video-workflow-v1" }],
		["transfer owned", { outputTransferToken: "writer" }],
		["active lease", { verificationLeasedUntil: new Date("2026-10-22T10:01:00Z") }],
		["future due", { verificationNextAttemptAt: new Date("2026-10-22T10:01:00Z") }],
	] as const)("does not query or submit %s", async (_label, patch) => {
		const f = fixture();
		Object.assign(f.asset, patch);
		await f.run();
		expect(f.update).not.toHaveBeenCalled();
		expect(f.retrieve).not.toHaveBeenCalled();
		expect(f.submit).not.toHaveBeenCalled();
	});

	it("rejects a changed epoch before claiming and preserves the final GET fence", async () => {
		const changed = fixture();
		changed.state.owner.epoch++;
		expect(await changed.run()).toMatchObject({ phaseOwnershipLost: true });
		expect(changed.retrieve).not.toHaveBeenCalled();
		const lost = fixture();
		lost.state.providerGate = false;
		expect(await lost.run()).toMatchObject({ phaseOwnershipLost: true });
		expect(lost.update).toHaveBeenCalledOnce();
		expect(lost.retrieve).not.toHaveBeenCalled();
	});

	it("reads DB time again for renewal instead of trusting the projection's live owner", async () => {
		const f = fixture();
		f.state.owner.leasedUntil = new Date("2026-10-22T09:59:59Z");
		expect(await f.run()).toMatchObject({ phaseOwnershipLost: true });
		expect(f.update).not.toHaveBeenCalled();
		expect(f.retrieve).not.toHaveBeenCalled();
	});

	it("invalidates the projected failure count after recording an expired lease", async () => {
		const f = fixture();
		f.asset.verificationLeaseToken = "expired";
		f.asset.verificationLeasedUntil = new Date("2026-10-22T09:59:59Z");
		f.state.failures = 3;
		await f.run();
		expect(f.count).toHaveBeenCalledOnce();
		expect(f.state.failures).toBe(4);
		expect(f.asset.status).toBe("VERIFICATION_FAILED");
		expect(f.retrieve).not.toHaveBeenCalled();
	});

	it("keeps copy reconciliation before and after the verdict", async () => {
		const f = fixture("INPUT");
		f.state.hasCopy = true;
		await f.run();
		expect(mocks.reconcileCopy).toHaveBeenCalledTimes(3);
	});

	it("retains historical inspection, previous review and administrator rejection", async () => {
		const f = fixture();
		f.state.legacyMarker = true;
		f.state.previous = { id: "historical", lastErrorCode: "OLD_ERROR", lastFailureAt: new Date(0) };
		f.state.adminRejected = true;
		expect(await f.run()).toMatchObject({ verificationCommit: { status: "QUARANTINED" } });
		expect(f.inspect).toHaveBeenCalledOnce();
		expect(f.evidence[0]).toMatchObject({
			status: "REJECTED",
			reasonCode: "ADMIN_CONTENT_REJECTED",
		});
		expect(mocks.recordOutcome).toHaveBeenCalledWith(
			expect.objectContaining({ status: "REJECTED", lastErrorCode: "OLD_ERROR" }),
			f.state.previous,
			expect.anything(),
		);
	});
});
