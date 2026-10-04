import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { createDatabaseVerifyUploadDependencies, createFinalizationDependencies } from "../runtime";

describe("lazy runtime moderation configuration", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("imports module-level dependencies while generation and moderation are disabled", async () => {
		vi.stubEnv("MEDIA_SAFETY_ADAPTER", "configured");
		vi.stubEnv("MODERATION_IMAGE_SEEAPI_ENABLED", "false");
		vi.stubEnv("MEDIA_GENERATION_ENABLED", "false");
		vi.stubEnv("SEEAPI_API_KEY", undefined);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		vi.resetModules();
		const runtime = await import("../runtime");
		await expect(runtime.databaseVerifyUploadDependencies.verify("disabled-asset")).rejects.toThrow(
			"IMAGE_MODERATION_CONFIGURATION_ERROR",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([undefined, "false", "invalid"])(
		"constructs dependencies with unavailable image moderation (%s), then fails before effects",
		async (enabled) => {
			vi.stubEnv("MEDIA_SAFETY_ADAPTER", "configured");
			vi.stubEnv("MODERATION_IMAGE_SEEAPI_ENABLED", enabled);
			vi.stubEnv("MEDIA_GENERATION_ENABLED", "false");
			vi.stubEnv("SEEAPI_API_KEY", undefined);
			const transaction = vi.fn();
			const inspect = vi.fn();
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			const database = { $transaction: transaction };
			let dependencies: ReturnType<typeof createDatabaseVerifyUploadDependencies> | undefined;
			expect(() => {
				dependencies = createDatabaseVerifyUploadDependencies(database as never, {
					inspectPrivateMediaObject: inspect,
				});
			}).not.toThrow();
			expect(() =>
				createFinalizationDependencies(process.env, { database: database as never }),
			).not.toThrow();
			await expect(dependencies!.verify("unconfigured-asset")).rejects.toThrow(
				/moderation|MODERATION/,
			);
			expect(transaction).not.toHaveBeenCalled();
			expect(inspect).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("rejects an enabled SeeAPI provider without credentials before claiming a database lease", async () => {
		vi.stubEnv("MEDIA_SAFETY_ADAPTER", "configured");
		vi.stubEnv("MODERATION_IMAGE_SEEAPI_ENABLED", "true");
		vi.stubEnv("SEEAPI_API_KEY", undefined);
		const transaction = vi.fn();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const dependencies = createDatabaseVerifyUploadDependencies({
			$transaction: transaction,
		} as never);
		await expect(dependencies.verify("unconfigured-asset")).rejects.toThrow(
			"IMAGE_MODERATION_CONFIGURATION_ERROR",
		);
		expect(transaction).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});
