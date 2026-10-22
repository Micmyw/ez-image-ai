import {
	TestMediaSafetyAdapter,
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
} from "@repo/ai";
import {
	MEDIA_VERIFICATION_OBSERVATION_SELECT,
	type MediaVerificationAdmission,
} from "@repo/database";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { unmanagedLegacyTask } from "../orchestration/legacy-task-ownership";
import { createDatabaseVerifyUploadDependencies } from "../runtime";
import { verifyUpload } from "./verify-upload";

function fixture(status: "READY" | "VERIFYING") {
	const asset = {
		id: "asset",
		kind: "OUTPUT" as const,
		status,
		updatedAt: new Date(),
		deletedAt: null,
		verificationEngine: "legacy",
		verificationGeneration: 1,
		verificationProvider: "seeapi",
		verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		verificationSubmissionUncertain: false,
		verificationLeaseToken: null,
		verificationLeasedUntil: null,
	};
	const findUnique = vi.fn(async () => asset);
	const claimRead = vi.fn(async () => ({
		...asset,
		mimeType: "image/png",
		verificationProviderTaskId: null,
	}));
	const lock = vi.fn(async () => 0);
	const query = vi.fn(async (sql: TemplateStringsArray) =>
		sql.join("?").includes('SELECT "phaseKey"')
			? []
			: [{ matched: true, eventIds: ["durable-event"] }],
	);
	const ownerQuery = vi.fn(async () => []);
	const transaction = vi.fn(async (operation: (tx: unknown) => unknown) =>
		operation({
			$executeRaw: lock,
			$queryRaw: ownerQuery,
			mediaAsset: { findUnique: claimRead },
		}),
	);
	const db = { mediaAsset: { findUnique }, $queryRaw: query, $transaction: transaction };
	const safety = new TestMediaSafetyAdapter("ALLOW");
	const moderate = vi.spyOn(safety, "moderateImage");
	const deps = createDatabaseVerifyUploadDependencies(db as never, {
		environment: {},
		moderationProvider: "seeapi",
		safety,
	});
	return { asset, db, findUnique, claimRead, lock, query, ownerQuery, transaction, moderate, deps };
}

describe("in-process verification admission reuse", () => {
	it("reuses the admission read and validates both terminal continuation and active phase ownership", async () => {
		const f = fixture("READY");
		let admission: MediaVerificationAdmission | undefined;
		expect(
			await unmanagedLegacyTask(f.db as never, { assetId: f.asset.id }, (value) => {
				admission = value;
			}),
		).toBeNull();
		expect(
			await verifyUpload({ assetId: f.asset.id, queryOnly: true }, f.deps, admission),
		).toMatchObject({ verificationObservation: { status: "READY", eventIds: ["durable-event"] } });
		expect(f.findUnique).toHaveBeenCalledExactlyOnceWith({
			where: { id: f.asset.id },
			select: MEDIA_VERIFICATION_OBSERVATION_SELECT,
		});
		expect(f.query).toHaveBeenCalledTimes(2);
		expect(f.transaction).not.toHaveBeenCalled();
		expect(f.moderate).not.toHaveBeenCalled();
	});

	it("adds no pre-read to an active query-only tick and keeps its authoritative claim read under lock", async () => {
		const f = fixture("VERIFYING");
		let admission: MediaVerificationAdmission | undefined;
		await unmanagedLegacyTask(f.db as never, { assetId: f.asset.id }, (value) => {
			admission = value;
		});
		expect(await verifyUpload({ assetId: f.asset.id, queryOnly: true }, f.deps, admission)).toEqual(
			{ outboxCommitted: false },
		);
		expect(f.findUnique).toHaveBeenCalledOnce();
		expect(f.query).not.toHaveBeenCalled();
		expect(f.transaction).toHaveBeenCalledOnce();
		expect(f.lock).toHaveBeenCalledOnce();
		expect(f.claimRead).toHaveBeenCalledOnce();
		expect(f.ownerQuery).toHaveBeenCalledOnce();
		expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(
			f.claimRead.mock.invocationCallOrder[0]!,
		);
		expect(f.moderate).not.toHaveBeenCalled();
	});

	it("rejects mismatched admission identity and leaves non-legacy ownership protected", async () => {
		const f = fixture("READY");
		f.asset.verificationEngine = "video-workflow-v1";
		expect(
			await unmanagedLegacyTask(f.db as never, { assetId: f.asset.id }, () => undefined),
		).toMatchObject({ outcome: "NOT_MANAGED", executionEngine: "video-workflow-v1" });
		expect(
			await f.deps.verify("different-asset", { queryOnly: true, admission: { asset: f.asset } }),
		).toEqual({ outboxCommitted: false });
		expect(f.query).not.toHaveBeenCalled();
		expect(f.claimRead).toHaveBeenCalledOnce();
		expect(f.moderate).not.toHaveBeenCalled();
	});
});
