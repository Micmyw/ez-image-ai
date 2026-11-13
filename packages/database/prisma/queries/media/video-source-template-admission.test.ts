import { describe, expect, it, vi } from "vitest";
vi.mock("./operations", () => ({ createRuntimeConfigOverride: vi.fn(async (input) => input) }));
import { sourceHotelTemplateFixture } from "../../../../config/test-support/source-hotel-template";
import { createRuntimeConfigOverride } from "./operations";
import {
	importDisabledSourceTemplateProvision,
	sourceTemplateAdmissionData,
} from "./video-source-template-admission";
const provision = {
	version: "source-v1",
	enabled: false,
	access: "internal",
	sourceConfig: {},
	references: [],
	prices: [],
};
describe("published source admission", () => {
	it("freezes each customer input identity without looking up fixed reference assets", async () => {
		const request = sourceHotelTemplateFixture();
		const now = new Date("2026-11-13T00:00:00Z");
		const tx = {
			runtimeConfigOverride: {
				findFirst: vi.fn(async () => ({
					id: request.sourceTemplate.provision.id,
					version: 1,
					value: { ...provision, version: request.sourceTemplate.version, enabled: true },
				})),
			},
			mediaAsset: {
				findFirst: vi.fn(async ({ where }) => {
					if (!["input-1", "input-2"].includes(where.id))
						throw new Error("UNEXPECTED_BUILT_IN_LOOKUP");
					return {
						id: where.id,
						kind: "INPUT",
						checksum: "a".repeat(64),
						objectKey: `users/owner/${where.id}`,
						storageEtag: "sealed",
						storageVersionId: null,
						verificationGeneration: 1,
						mimeType: "image/png",
						width: 720,
						height: 1280,
						byteSize: 100n,
						verificationEngine: "video-workflow-v1",
						status: "VERIFYING",
					};
				}),
			},
		};
		const result = await sourceTemplateAdmissionData(
			"owner",
			request,
			10_000_000,
			tx as never,
			now,
		);
		expect(result.roleInputIdentities).toMatchObject([
			{ role: "performer-1", assetId: "input-1", storageEtag: "sealed" },
			{ role: "performer-2", assetId: "input-2", storageEtag: "sealed" },
		]);
		expect(tx.mediaAsset.findFirst).toHaveBeenCalledTimes(2);
		for (const [{ where }] of tx.mediaAsset.findFirst.mock.calls) {
			expect(where).toMatchObject({
				ownerType: "USER",
				ownerId: "owner",
				deletedAt: null,
				finalizedAt: { not: null },
			});
		}
		tx.mediaAsset.findFirst.mockResolvedValueOnce(null as never);
		await expect(
			sourceTemplateAdmissionData("owner", request, 10_000_000, tx as never, now),
		).rejects.toThrow("VIDEO_INPUT_NOT_AVAILABLE");
	});
});
describe("disabled source provisioning import", () => {
	it("uses the existing versioned audited writer and does not activate the template", async () => {
		const client = { user: { findFirst: vi.fn(async () => ({ id: "admin" })) } };
		await importDisabledSourceTemplateProvision(
			{
				templateKey: "original-rap",
				value: provision,
				actorUserId: "admin",
				reason: "Import archived source configuration",
			},
			client as never,
		);
		expect(createRuntimeConfigOverride).toHaveBeenCalledWith(
			{
				configKey: "media.source-template.original-rap.provision",
				value: provision,
				createdByUserId: "admin",
				reason: "Import archived source configuration",
			},
			client,
		);
	});
	it("denies non-admins and rejects an enabled import", async () => {
		const client = { user: { findFirst: vi.fn(async () => null) } };
		await expect(
			importDisabledSourceTemplateProvision(
				{ templateKey: "original-rap", value: provision, actorUserId: "user", reason: "test" },
				client as never,
			),
		).rejects.toThrow("VIDEO_ACCESS_DENIED");
		await expect(
			importDisabledSourceTemplateProvision(
				{
					templateKey: "original-rap",
					value: { ...provision, enabled: true },
					actorUserId: "admin",
					reason: "test",
				},
				client as never,
			),
		).rejects.toThrow("VIDEO_TEMPLATE_IMPORT_MUST_BE_DISABLED");
	});
});
