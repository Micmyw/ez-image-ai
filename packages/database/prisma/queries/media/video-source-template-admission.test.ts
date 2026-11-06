import { describe, expect, it, vi } from "vitest";
vi.mock("./operations", () => ({ createRuntimeConfigOverride: vi.fn(async (input) => input) }));
import { createRuntimeConfigOverride } from "./operations";
import { importDisabledSourceTemplateProvision } from "./video-source-template-admission";
const provision = {
	version: "source-v1",
	enabled: false,
	access: "internal",
	sourceConfig: {},
	references: [],
	prices: [],
};
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
