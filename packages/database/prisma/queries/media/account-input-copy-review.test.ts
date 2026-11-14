import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({ getDatabaseClient: vi.fn() }));
vi.mock("./credits", () => ({}));

import type { Prisma } from "../../generated/client";
import {
	freezeAccountInputCopyReview,
	inheritAccountInputCopyReview,
	type AccountInputCopyReadbackProof,
} from "./account-input-copy-review";

type Asset = Prisma.MediaAssetGetPayload<{ include: { moderationResults: true } }>;
const now = new Date("2026-11-14T06:00:00Z");
const until = new Date("2026-11-15T06:00:00Z");
const policy = { provider: "seeapi", ruleVersion: "current-rule", policyVersion: "current-policy" };

function fixture() {
	const source = {
		id: "source",
		ownerType: "USER",
		ownerId: "guest",
		kind: "INPUT",
		status: "READY",
		retentionClass: "GUEST_TRIAL",
		verificationEngine: "legacy",
		objectKey: "users/guest/assets/source/versions/upload/original.png",
		mimeType: "image/png",
		byteSize: 16n,
		checksum: "a".repeat(64),
		deletedAt: null,
		finalizedAt: new Date("2026-11-14T05:59:00Z"),
		storageEtag: "source-etag",
		storageVersionId: "source-version",
		watermarkVersion: null,
		watermarkedAt: null,
		verificationGeneration: 1,
		verificationAttemptCount: 3,
		verificationSubmissionUncertain: false,
		verificationLeaseToken: null,
		verificationLeasedUntil: null,
		verificationNextAttemptAt: null,
		verificationExhaustedAt: null,
		verificationLastErrorCode: null,
		verificationProvider: "seeapi",
		verificationProviderTaskId: "source-task",
		verificationRuleVersion: policy.ruleVersion,
		verificationPolicyVersion: policy.policyVersion,
		verificationValidUntil: until,
		moderationResults: [
			{
				id: "source-result",
				assetId: "source",
				status: "APPROVED",
				reasonCode: "NO_POLICY_MATCH",
				assetChecksum: "a".repeat(64),
				verificationGeneration: 1,
				attemptNumber: 3,
				evidenceKind: "INPUT",
				provider: "seeapi",
				providerTaskId: "source-task",
				ruleVersion: policy.ruleVersion,
				policyVersion: policy.policyVersion,
				validUntil: until,
				createdAt: new Date("2026-11-14T05:59:10Z"),
				categories: {},
				rawEnvelope: {
					decision: "ALLOW",
					evidence: {
						requestId: "source-task",
						models: ["nsfw-filter-2"],
						operations: 1,
						scores: {},
						seeapi: { taskId: "source-task", flagged: false, nsfw: [], specialCare: [] },
					},
				},
			},
		],
	} as unknown as Asset;
	const target = {
		assetId: "target",
		ownerId: "account",
		objectKey: "users/account/assets/target/versions/copy/original.png",
	};
	const proof: AccountInputCopyReadbackProof = {
		schemaVersion: 1,
		method: "immutable-target-full-sha256-v1",
		transform: "none",
		promotionId: "promotion",
		leaseToken: "lease",
		sourceAssetId: source.id,
		sourceObjectKey: source.objectKey,
		targetAssetId: target.assetId,
		targetObjectKey: target.objectKey,
		checksum: source.checksum!,
		bytes: 16,
		mimeType: "image/png",
		storageEtag: "target-etag",
		storageVersionId: "target-version",
	};
	const input = {
		promotionId: "promotion",
		leaseToken: "lease",
		source,
		target,
		policy,
		now,
		proof,
		uncertainWriter: false,
		storageEtag: "target-etag",
		storageVersionId: "target-version",
	};
	const writes: Array<{ sql: string; values: unknown[] }> = [];
	let frozen: unknown;
	let historyCount = 1;
	const tx = {
		$queryRaw: async (strings: TemplateStringsArray) => {
			const sql = strings.join("?");
			if (sql.includes("count(*)")) return [{ count: historyCount }];
			if (sql.includes("ACCOUNT_INPUT_COPY_REVIEW_SOURCE"))
				return frozen ? [{ id: "frozen-source", payload: frozen }] : [];
			throw new Error(`UNEXPECTED_QUERY:${sql}`);
		},
		$executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = strings.join("?");
			writes.push({ sql, values });
			if (sql.includes("ACCOUNT_INPUT_COPY_REVIEW_SOURCE")) frozen = JSON.parse(String(values[3]));
			return 1;
		},
	} as unknown as Prisma.TransactionClient;
	return {
		source,
		proof,
		input,
		tx,
		writes,
		setHistoryCount: (value: number) => {
			historyCount = value;
		},
		clearFrozen: () => {
			frozen = undefined;
		},
	};
}

describe("immutable account copy derived approval", () => {
	it("compares the frozen finalized identity without assuming the application and database clocks agree", async () => {
		const f = fixture();
		f.source.finalizedAt = new Date(now.getTime() + 1000);
		await freezeAccountInputCopyReview(f.input, f.tx);
		expect(await inheritAccountInputCopyReview(f.input, f.tx)).toBe(true);
	});
	it("binds the exact source review, byte readback and current copy lease without inventing a target provider task", async () => {
		const f = fixture();
		await freezeAccountInputCopyReview(f.input, f.tx);
		expect(await inheritAccountInputCopyReview(f.input, f.tx)).toBe(true);
		const evidence = f.writes.find((write) =>
			write.sql.includes('INSERT INTO "asset_moderation_result"'),
		)!;
		expect(evidence.sql).toContain("NULL");
		expect(evidence.sql).toContain("IMMUTABLE_ACCOUNT_INPUT_COPY_V1");
		const envelope = evidence.values
			.map((value) => {
				try {
					return typeof value === "string" ? JSON.parse(value) : null;
				} catch {
					return null;
				}
			})
			.find((value) => value?.provenance);
		expect(envelope).toMatchObject({
			provenance: "IMMUTABLE_ACCOUNT_INPUT_COPY_V1",
			receipt: {
				promotionId: "promotion",
				leaseToken: "lease",
				transform: "none",
				sourceReviewReceiptId: "frozen-source",
				sourceAssetId: "source",
				targetAssetId: "target",
				sourceEvidence: { id: "source-result", providerTaskId: "source-task" },
			},
		});
		expect(evidence.values).not.toContain("source-task");
	});

	it.each([
		[
			"pending",
			(f: ReturnType<typeof fixture>) => {
				f.source.status = "VERIFYING";
			},
		],
		[
			"expired",
			(f: ReturnType<typeof fixture>) => {
				f.input.now = until;
			},
		],
		[
			"administrator approval",
			(f: ReturnType<typeof fixture>) => {
				f.source.moderationResults[0]!.reasonCode = "ADMIN_CONTENT_APPROVED";
			},
		],
		[
			"bypass",
			(f: ReturnType<typeof fixture>) => {
				f.source.moderationResults[0]!.status = "BYPASSED";
			},
		],
		[
			"prior generation",
			(f: ReturnType<typeof fixture>) => {
				f.source.verificationGeneration = 2;
			},
		],
		[
			"prior abnormal verdict",
			(f: ReturnType<typeof fixture>) => {
				f.setHistoryCount(2);
			},
		],
		[
			"unknown review submission",
			(f: ReturnType<typeof fixture>) => {
				f.source.verificationSubmissionUncertain = true;
			},
		],
		[
			"live review lease",
			(f: ReturnType<typeof fixture>) => {
				f.source.verificationLeaseToken = "active";
			},
		],
		[
			"review error history",
			(f: ReturnType<typeof fixture>) => {
				f.source.verificationLastErrorCode = "FAILED";
			},
		],
		[
			"watermark",
			(f: ReturnType<typeof fixture>) => {
				f.source.watermarkVersion = "guest-v1";
			},
		],
		[
			"transformed guest output",
			(f: ReturnType<typeof fixture>) => {
				f.source.kind = "OUTPUT";
			},
		],
		[
			"missing finalized identity",
			(f: ReturnType<typeof fixture>) => {
				f.source.finalizedAt = null;
			},
		],
		[
			"historical provider",
			(f: ReturnType<typeof fixture>) => {
				f.source.verificationProvider = "sightengine";
			},
		],
		[
			"stale rule",
			(f: ReturnType<typeof fixture>) => {
				f.input.policy = { ...policy, ruleVersion: "next-rule" };
			},
		],
		[
			"stale policy",
			(f: ReturnType<typeof fixture>) => {
				f.input.policy = { ...policy, policyVersion: "next-policy" };
			},
		],
		[
			"missing authenticated detector evidence",
			(f: ReturnType<typeof fixture>) => {
				f.source.moderationResults[0]!.rawEnvelope = { decision: "ALLOW" };
			},
		],
	] as const)("keeps %s on the ordinary target-review path", async (_, mutate) => {
		const f = fixture();
		mutate(f);
		await freezeAccountInputCopyReview(f.input, f.tx);
		expect(await inheritAccountInputCopyReview(f.input, f.tx)).toBe(false);
		expect(f.writes).toEqual([]);
	});

	it.each([
		["leaseToken", "other-lease"],
		["sourceAssetId", "other-source"],
		["sourceObjectKey", "other-key"],
		["targetAssetId", "other-target"],
		["targetObjectKey", "other-key"],
		["checksum", "b".repeat(64)],
		["bytes", 17],
		["mimeType", "image/jpeg"],
		["storageEtag", "other-etag"],
		["storageVersionId", "other-version"],
		["transform", "watermark"],
		["method", "browser-sha256"],
	] as const)("rejects a readback proof with changed %s", async (field, value) => {
		const f = fixture();
		await freezeAccountInputCopyReview(f.input, f.tx);
		Object.assign(f.proof, { [field]: value });
		expect(await inheritAccountInputCopyReview(f.input, f.tx)).toBe(false);
		expect(f.writes).toHaveLength(1);
	});

	it.each(["finalizedAt", "ownerId", "storageEtag", "storageVersionId", "evidence-id"])(
		"does not reuse a source whose %s changed during the storage copy",
		async (field) => {
			const f = fixture();
			await freezeAccountInputCopyReview(f.input, f.tx);
			if (field === "finalizedAt") f.source.finalizedAt = new Date("2026-11-14T05:59:05Z");
			else if (field === "evidence-id") f.source.moderationResults[0]!.id = "another-result";
			else Object.assign(f.source, { [field]: "changed" });
			expect(await inheritAccountInputCopyReview(f.input, f.tx)).toBe(false);
			expect(f.writes).toHaveLength(1);
		},
	);

	it.each(["missing frozen receipt", "unknown copy", "missing readback"])(
		"falls back for %s",
		async (caseName) => {
			const f = fixture();
			await freezeAccountInputCopyReview(f.input, f.tx);
			if (caseName === "missing frozen receipt") f.clearFrozen();
			if (caseName === "unknown copy") f.input.uncertainWriter = true;
			const input = { ...f.input, proof: caseName === "missing readback" ? undefined : f.proof };
			expect(await inheritAccountInputCopyReview(input, f.tx)).toBe(false);
			expect(f.writes).toHaveLength(1);
		},
	);
});
