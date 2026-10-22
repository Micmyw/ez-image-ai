import { TestMediaSafetyAdapter } from "@repo/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	reconcile: vi.fn(),
	claim: vi.fn(),
	register: vi.fn(),
	clear: vi.fn(),
	commit: vi.fn(),
	fail: vi.fn(),
	recover: vi.fn(),
	orphan: vi.fn(),
	pass: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database", () => ({
	getImagePhaseOwner: async () => undefined,
	lockAssetPromptReview: async () => false,
	recordModerationOutcome: async () => undefined,
	recordLockedAssetModerationOutcome: async () => undefined,
}));
vi.mock("@repo/database/media-account-input-copy", () => ({
	claimAccountInputCopy: mocks.claim,
	registerAccountInputCopyMultipart: mocks.register,
	clearAccountInputCopyMultipart: mocks.clear,
	commitAccountInputCopy: mocks.commit,
	failAccountInputCopy: mocks.fail,
	recoverAccountInputCopies: mocks.recover,
	claimAccountInputCopyOrphan: mocks.orphan,
	recordAccountInputCopyOrphanPass: mocks.pass,
	reconcileAccountInputCopyTargetInTransaction: mocks.reconcile,
}));

import {
	createDatabaseAccountInputCopyDependencies,
	createDatabaseVerifyUploadDependencies,
} from "../runtime";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.reconcile.mockResolvedValue({ terminal: false });
});

function verificationFixture(
	status: "VERIFYING" | "QUARANTINED" = "VERIFYING",
	decision: "REJECT" | "ERROR" | "ALLOW" | "REVIEW" = "REJECT",
) {
	const evidence: Record<string, unknown>[] = [];
	const asset = {
		id: "copy-target",
		kind: "INPUT",
		verificationEngine: "legacy",
		ownerId: "account",
		status,
		deletedAt: null,
		objectKey: "users/account/assets/copy-target/versions/copy/original.png",
		mimeType: "image/png",
		byteSize: 16n,
		checksum: "a".repeat(64),
		finalizedAt: new Date(),
		verificationGeneration: 1,
		verificationAttemptCount: 0,
		verificationProviderTaskId: null,
		verificationLastErrorCode: status === "QUARANTINED" ? "LEGACY_EVIDENCE_UNTRUSTED" : null,
		verificationNextAttemptAt: null,
		verificationDeadlineAt: new Date(Date.now() + 120_000),
		verificationLeaseToken: null,
		verificationLeasedUntil: null,
	};
	const update = async ({ data }: { data: Record<string, unknown> }) => Object.assign(asset, data);
	const tx = {
		$executeRaw: async () => 1,
		$queryRaw: async () => [
			{ current: asset.status === "VERIFYING" && !!asset.verificationLeaseToken },
		],
		mediaAsset: {
			findUnique: async () => ({ ...asset }),
			findUniqueOrThrow: async () => ({ ...asset }),
			findFirst: async () => ({ ...asset }),
			update,
			updateMany: async (input: { data: Record<string, unknown> }) => {
				await update(input);
				return { count: 1 };
			},
		},
		auditLog: { findFirst: async () => null, create: async () => ({}) },
		assetModerationResult: {
			findFirst: async () => null,
			createMany: async ({ data }: { data: Record<string, unknown> }) => {
				evidence.push(data);
				return { count: 1 };
			},
			count: async () => (decision === "ERROR" ? 4 : 0),
		},
		moderationReview: { updateMany: async () => ({ count: 0 }), findUnique: async () => null },
		generationJobAsset: { findMany: async () => [] },
	};
	const database = {
		...tx,
		$transaction: async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx),
	};
	const deps = createDatabaseVerifyUploadDependencies(database as never, {
		moderationProvider: "test",
		safety: new TestMediaSafetyAdapter(decision),
		inspectPrivateMediaObject: async () => ({
			bytes: 16,
			sha256: "a".repeat(64),
			etag: "tag",
			versionId: null,
		}),
		headObject: async () => ({
			contentLength: 16,
			contentType: "image/png",
			etag: "tag",
			metadata: {},
		}),
		readMediaHeader: async () => Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		createSignedReadUrl: async () => "https://private.example/input",
		onVerificationError: (error) => {
			throw error;
		},
	});
	return { asset, tx, deps, evidence };
}

describe("account-copy production runtime boundaries", () => {
	it("wires business lease methods to the supplied database without surrounding storage with a transaction", async () => {
		const database = {};
		const dependencies = createDatabaseAccountInputCopyDependencies(database as never);
		await dependencies.claim({ promotionId: "copy" });
		expect(mocks.claim).toHaveBeenCalledWith({ promotionId: "copy" }, database);
		await dependencies.registerMultipart({
			promotionId: "copy",
			leaseToken: "lease",
			multipartUploadId: "mpu",
		});
		expect(mocks.register).toHaveBeenCalledWith(
			{ promotionId: "copy", leaseToken: "lease", multipartUploadId: "mpu" },
			database,
		);
	});

	it("rejects terminal copy targets before explicit legacy re-verification can reset them", async () => {
		const state = verificationFixture("QUARANTINED");
		mocks.reconcile.mockResolvedValue({ terminal: true });
		const before = structuredClone(state.asset);
		await state.deps.verify(state.asset.id, { allowQuarantinedReverification: true });
		expect(state.asset).toEqual(before);
		expect(mocks.reconcile).toHaveBeenCalledWith({ assetId: state.asset.id }, state.tx);
	});

	it("reconciles a moderation rejection inside the transaction that records its terminal target state", async () => {
		const state = verificationFixture();
		const observed: string[] = [];
		mocks.reconcile.mockImplementation(async () => {
			observed.push(state.asset.status);
			return { terminal: false };
		});
		await state.deps.verify(state.asset.id);
		expect(observed).toContain("QUARANTINED");
	});

	it("passes the normal quarantined REVIEW evidence to copy reconciliation", async () => {
		const state = verificationFixture("VERIFYING", "REVIEW");
		const observed: string[] = [];
		mocks.reconcile.mockImplementation(async () => {
			observed.push(state.asset.status);
			return { terminal: false };
		});
		await state.deps.verify(state.asset.id);
		expect(observed).toContain("QUARANTINED");
		expect(state.asset).toMatchObject({ status: "QUARANTINED", deletedAt: null });
		expect(state.evidence).toContainEqual(
			expect.objectContaining({
				assetId: state.asset.id,
				assetChecksum: state.asset.checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				status: "REVIEW",
				validUntil: null,
			}),
		);
	});

	it("reconciles exhausted verification before its transaction can finish", async () => {
		const state = verificationFixture("VERIFYING", "ERROR");
		const observed: string[] = [];
		mocks.reconcile.mockImplementation(async () => {
			observed.push(state.asset.status);
			return { terminal: false };
		});
		await state.deps.verify(state.asset.id);
		expect(observed).toContain("VERIFICATION_FAILED");
	});

	it("rejects a late approval when the copy becomes terminal after its verification claim", async () => {
		const state = verificationFixture("VERIFYING", "ALLOW");
		mocks.reconcile
			.mockResolvedValueOnce({ terminal: false })
			.mockResolvedValue({ terminal: true });
		await state.deps.verify(state.asset.id);
		expect(state.asset.status).toBe("VERIFYING");
	});
});
