import { describe, expect, it, vi } from "vitest";

import {
	commitSourceTemplateMaterial,
	reserveSourceTemplateMaterial,
	sourceMaterialImportIdentity,
	isSourceTemplateAdministratorApproval,
	type SourceMaterialImportApproval,
} from "./source-template-material-import";
import type { MediaTransactionClient } from "./types";

const now = new Date("2026-11-06T09:00:00.000Z");
const approval: SourceMaterialImportApproval = {
	approvalReceiptId: "local-fixture-approval",
	approvalKind: "test-fixture",
	targetEnvironment: "local",
	templateKey: "58th-floor",
	version: "source-v1",
	ownerId: "admin-fixture",
	sourceUrl: "https://ezpic-template.example/source/test",
	checksum: "a".repeat(64),
	bytes: 100,
	mimeType: "image/png",
	decision: "ALLOW",
	reviewedAt: "2026-11-06T08:59:00.000Z",
	validUntil: "2026-11-07T09:00:00.000Z",
	rightsEvidence: "test-only user instruction fixture",
	ruleVersion: "source-v1",
	policyVersion: "source-v1",
	sourceProvenance: {
		sourceRepository: "ez-airapvideo",
		sourceCommit: "b".repeat(40),
		sourceConfigKey: "floor58",
		sourceRole: "scene",
		sourceAssetSha256: "a".repeat(64),
		sourceRevision: "source-v1",
		sourceUrlSha256: null,
		inspectionReceiptId: "fixture-inspection",
		inspector: "test fixture",
		inspectionMethod: "visual-and-source-hash",
		inspectedAt: "2026-11-06T08:00:00.000Z",
	},
};
function fixture() {
	let asset: Record<string, unknown> | null = null;
	let reservation: Record<string, unknown> | null = null;
	let evidence: Record<string, unknown> | null = null;
	const order: string[] = [];
	const tx = {
		$executeRaw: vi.fn(async () => {
			order.push("lock");
			return 1;
		}),
		$queryRaw: vi.fn(async () => [{ now }]),
		user: { findFirst: vi.fn(async () => ({ id: approval.ownerId })) },
		mediaAsset: {
			findUnique: vi.fn(async () => asset),
			create: vi.fn(async ({ data }) => {
				asset = { ...data, deletedAt: null };
				return asset;
			}),
			update: vi.fn(async ({ data }) => {
				asset = { ...asset, ...data };
				return asset;
			}),
		},
		storageUsageReservation: {
			findUnique: vi.fn(async () => reservation),
			aggregate: vi.fn(async () => {
				order.push("usage");
				return { _sum: { bytes: 0n } };
			}),
			create: vi.fn(async ({ data }) => {
				reservation = { id: "reservation", status: "ACTIVE", ...data };
				return reservation;
			}),
			update: vi.fn(async ({ data }) => {
				reservation = { ...reservation, ...data };
				return reservation;
			}),
		},
		assetModerationResult: {
			findUnique: vi.fn(async () => evidence),
			create: vi.fn(async ({ data }) => {
				evidence = data;
				return data;
			}),
		},
	};
	const client = {
		$transaction: vi.fn(async (callback) => callback(tx)),
	} as unknown as MediaTransactionClient;
	return { tx, client, order, getAsset: () => asset, getEvidence: () => evidence };
}
const stored = { bytes: 100, sha256: approval.checksum, etag: "original-etag", versionId: null };

describe("source material durable import", () => {
	it("reserves once and commits one original object plus administrator evidence; replay preserves both", async () => {
		const f = fixture();
		await reserveSourceTemplateMaterial(approval, 1000n, f.client);
		await reserveSourceTemplateMaterial(approval, 1000n, f.client);
		expect(f.tx.mediaAsset.create).toHaveBeenCalledTimes(1);
		expect(f.order.indexOf("lock")).toBeLessThan(f.order.indexOf("usage"));
		const first = await commitSourceTemplateMaterial(approval, stored, f.client);
		expect(await commitSourceTemplateMaterial(approval, stored, f.client)).toEqual(first);
		expect(f.tx.assetModerationResult.create).toHaveBeenCalledTimes(1);
		expect(f.getAsset()).toMatchObject({
			status: "READY",
			verificationProvider: "administrator",
			verificationProviderTaskId: null,
		});
		expect(f.getEvidence()).toMatchObject({
			provider: "administrator",
			providerTaskId: null,
			status: "APPROVED",
		});
	});
	it("denies a nonadministrator before creating a reservation or asset", async () => {
		const f = fixture();
		f.tx.user.findFirst.mockResolvedValue(null as never);
		await expect(reserveSourceTemplateMaterial(approval, 1000n, f.client)).rejects.toThrow(
			"SOURCE_TEMPLATE_ADMIN_OWNER_REQUIRED",
		);
		expect(f.tx.mediaAsset.create).not.toHaveBeenCalled();
	});
	it("enforces aggregate quota while holding the owner storage fence", async () => {
		const f = fixture();
		f.tx.storageUsageReservation.aggregate.mockResolvedValue({ _sum: { bytes: 950n } });
		await expect(reserveSourceTemplateMaterial(approval, 1000n, f.client)).rejects.toThrow(
			"STORAGE_QUOTA_EXCEEDED",
		);
		expect(f.tx.storageUsageReservation.create).not.toHaveBeenCalled();
	});
	it("does not approve mismatched stored bytes and retains the reservation", async () => {
		const f = fixture();
		await reserveSourceTemplateMaterial(approval, 1000n, f.client);
		await expect(
			commitSourceTemplateMaterial(approval, { ...stored, sha256: "c".repeat(64) }, f.client),
		).rejects.toThrow("SOURCE_TEMPLATE_STORAGE_IDENTITY_MISMATCH");
		expect(f.tx.assetModerationResult.create).not.toHaveBeenCalled();
		expect(f.tx.storageUsageReservation.update).not.toHaveBeenCalled();
	});
	it.each([
		{ reviewedAt: "2026-11-08T00:00:00.000Z" },
		{ validUntil: "2026-11-05T00:00:00.000Z" },
		{ targetEnvironment: "production" as const },
	])("rejects invalid approval dates/fixture target before writes (%j)", async (patch) => {
		const f = fixture();
		await expect(
			reserveSourceTemplateMaterial({ ...approval, ...patch }, 1000n, f.client),
		).rejects.toThrow("SOURCE_TEMPLATE_APPROVAL_INVALID");
		expect(f.tx.mediaAsset.create).not.toHaveBeenCalled();
	});
	it("freezes each receipt and template into its own immutable import identity", () => {
		expect(sourceMaterialImportIdentity(approval)).toEqual(
			sourceMaterialImportIdentity({ ...approval }),
		);
		expect(
			sourceMaterialImportIdentity({ ...approval, approvalReceiptId: "other" }).assetId,
		).not.toBe(sourceMaterialImportIdentity(approval).assetId);
	});
	it("binds approval to every identity, provenance and expected deployment environment", async () => {
		const f = fixture();
		await reserveSourceTemplateMaterial(approval, 1000n, f.client);
		const {
			templateKey,
			version,
			approvalKind: _kind,
			...reference
		} = await commitSourceTemplateMaterial(approval, stored, f.client);
		const raw = f.getEvidence()!.rawEnvelope as { sourceTemplateReferenceApproval: unknown };
		const expected = {
			templateKey,
			version,
			reference,
			mimeType: "image/png",
			now,
			targetEnvironment: "local",
		};
		expect(
			isSourceTemplateAdministratorApproval(raw.sourceTemplateReferenceApproval, expected),
		).toBe(true);
		expect(
			isSourceTemplateAdministratorApproval(raw.sourceTemplateReferenceApproval, {
				...expected,
				targetEnvironment: "production",
			}),
		).toBe(false);
		expect(
			isSourceTemplateAdministratorApproval(raw.sourceTemplateReferenceApproval, {
				...expected,
				reference: { ...reference, checksum: "c".repeat(64) },
			}),
		).toBe(false);
		vi.stubEnv("NODE_ENV", "production");
		try {
			expect(
				isSourceTemplateAdministratorApproval(raw.sourceTemplateReferenceApproval, expected),
			).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
