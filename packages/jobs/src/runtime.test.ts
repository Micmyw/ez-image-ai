import { describe, expect, it, vi } from "vitest";

import { deleteStorageObject } from "./handlers/cleanup-storage-object";
import {
	createDatabaseDispatchStore,
	createProviderRegistry,
	createReconciliationProviderRegistry,
	createProviderWebhookVerifierRegistry,
	createDatabaseStorageCleanupDependencies,
} from "./runtime";

describe("provider runtime registration", () => {
	it("physically deletes expired guest objects after database read authorization is already closed", async () => {
		const assetAuthorizationLookup = vi.fn(() => {
			throw new Error("cleanup must not reopen guest read authorization");
		});
		const create = vi.fn(async () => ({ id: "cleanup-audit" }));
		const dependencies = createDatabaseStorageCleanupDependencies(
			{
				auditLog: { findFirst: vi.fn(async () => null) },
				mediaAsset: { findFirst: assetAuthorizationLookup },
				$transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
					operation({
						auditLog: { create },
						storageUsageReservation: { updateMany: vi.fn(async () => ({ count: 0 })) },
					}),
			} as never,
			{
				deleteObject: vi.fn(async () => undefined),
				abortMultipartUpload: vi.fn(async () => undefined),
				listMultipartUploads: vi.fn(async () => []),
			},
		);

		await deleteStorageObject(
			{
				assetId: "guest-output",
				objectKey: "users/guest/assets/guest-output/watermarked.png",
				cleanupObjectKeys: ["users/guest/staging/guest-output/clean.png"],
			},
			dependencies,
		);

		expect(assetAuthorizationLookup).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				action: "MEDIA_OBJECT_DELETE_COMPLETED",
				targetType: "MEDIA_STORAGE_OPERATION",
			}),
		});
	});

	it("fails production worker admission when an explicitly enabled provider lacks its credential", () => {
		expect(() =>
			createProviderRegistry({
				NODE_ENV: "production",
				MEDIA_ENABLED_PROVIDERS: "replicate,fal,kie,gemini",
				REPLICATE_API_TOKEN: "replicate-worker-secret",
				FAL_API_KEY: "fal-worker-secret",
				KIE_API_KEY: "kie-worker-secret",
			}),
		).toThrow("PROVIDER_WORKER_CREDENTIAL_MISSING:gemini");
	});

	it("keeps ordinary production admission strict while recovery omits unavailable adapters", () => {
		const environment = {
			NODE_ENV: "production",
			MEDIA_ENABLED_PROVIDERS: "replicate",
			MEDIA_RECOVERY_PROVIDERS: "replicate",
		};

		expect(() => createProviderRegistry(environment)).toThrow(
			"PROVIDER_WORKER_CREDENTIAL_MISSING:replicate",
		);
		expect([...createReconciliationProviderRegistry(environment).keys()]).toEqual([]);
	});

	it("builds the full configured production worker graph when all credentials exist", () => {
		const registry = createProviderRegistry({
			NODE_ENV: "production",
			MEDIA_ENABLED_PROVIDERS: "replicate,fal,kie,gemini",
			REPLICATE_API_TOKEN: "replicate-worker-secret",
			FAL_API_KEY: "fal-worker-secret",
			KIE_API_KEY: "kie-worker-secret",
			GEMINI_API_KEY: "gemini-worker-secret",
		});

		expect([...registry.keys()]).toEqual(["replicate", "fal", "kie", "gemini"]);
	});

	it("registers only configured providers that have local credentials", () => {
		const registry = createProviderRegistry({
			MEDIA_ENABLED_PROVIDERS: "replicate",
			REPLICATE_API_TOKEN: "replicate-worker-secret",
			FAL_API_KEY: "unconfigured-worker-secret",
		});

		expect(registry.get("replicate").provider).toBe("replicate");
		expect(() => registry.get("fal")).toThrow("not registered");
		expect([...registry.keys()]).toEqual(["replicate"]);
	});

	it("does not register a submit adapter in a worker process without the configured provider credential", () => {
		const registry = createProviderRegistry({ MEDIA_ENABLED_PROVIDERS: "replicate" });

		expect([...registry.keys()]).toEqual([]);
	});

	it("registers a disabled provider only in a recovery registry and only with worker credentials", () => {
		const environment = {
			MEDIA_ENABLED_PROVIDERS: "fal",
			MEDIA_RECOVERY_PROVIDERS: "replicate,fal",
			REPLICATE_API_TOKEN: "replicate-worker-secret",
			FAL_API_KEY: "fal-worker-secret",
		};

		expect([...createProviderRegistry(environment).keys()]).toEqual(["fal"]);
		expect([...createReconciliationProviderRegistry(environment).keys()]).toEqual([
			"replicate",
			"fal",
		]);
		expect([
			...createProviderRegistry(environment, { includeRecoveryProviders: true }).keys(),
		]).toEqual(["replicate", "fal"]);
	});

	it("creates a Replicate webhook verifier from a recovery secret without exposing a submit adapter", () => {
		const environment = {
			MEDIA_ENABLED_PROVIDERS: "",
			MEDIA_RECOVERY_PROVIDERS: "replicate",
			REPLICATE_WEBHOOK_SECRET: "whsec_dGVzdC1zZWNyZXQ=",
		};

		expect([
			...createProviderRegistry(environment, { includeRecoveryProviders: true }).keys(),
		]).toEqual([]);
		expect(createProviderWebhookVerifierRegistry(environment).get("replicate")).toBeDefined();
	});

	it("atomically requeues a late database kill-switch block without creating a provider attempt", async () => {
		const transaction = {
			$executeRaw: vi.fn(async () => 0),
			generationJob: {
				findFirst: vi.fn(async () => ({
					id: "job_1",
					version: 7,
					status: "DISPATCH_QUEUED",
					productKey: "image-fast",
					attempts: [],
					assets: [],
					quote: { costMicros: 1n },
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			runtimeConfigOverride: { findFirst: vi.fn(async () => ({ id: "override_1" })) },
			outboxEvent: { upsert: vi.fn(async () => ({})) },
		};
		const store = createDatabaseDispatchStore(
			{
				$transaction: async (callback: (value: typeof transaction) => unknown) =>
					callback(transaction),
			} as never,
			{
				environment: { MEDIA_GENERATION_ENABLED: "true" },
				enabledProviders: new Set(["replicate"]),
			},
		);

		await expect(store.claimDispatch({ jobId: "job_1", version: 7 })).rejects.toMatchObject({
			name: "DispatchAdmissionBlockedError",
			code: "MEDIA_GENERATION_DISABLED",
		});
		expect(transaction.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "job_1", version: 7 }),
				data: { version: { increment: 1 } },
			}),
		);
		expect(transaction.outboxEvent.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { dedupeKey: "generation-dispatch-kill-switch:job_1:8" },
				create: expect.objectContaining({ payload: { jobId: "job_1", version: 8 } }),
			}),
		);
	});

	it("blocks a queued Quality edit when the production launch switch is disabled", async () => {
		const transaction = {
			$executeRaw: vi.fn(async () => 0),
			generationJob: {
				findFirst: vi.fn(async () => ({
					id: "job_quality",
					version: 4,
					status: "DISPATCH_QUEUED",
					productKey: "image-quality",
					attempts: [],
					assets: [],
					quote: { costMicros: 8_000n },
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			runtimeConfigOverride: { findFirst: vi.fn(async () => null) },
			outboxEvent: { upsert: vi.fn(async () => ({})) },
		};
		const store = createDatabaseDispatchStore(
			{
				$transaction: async (callback: (value: typeof transaction) => unknown) =>
					callback(transaction),
			} as never,
			{
				environment: {
					MEDIA_GENERATION_ENABLED: "true",
					MEDIA_QUALITY_EDIT_ENABLED: "false",
				},
				enabledProviders: new Set(["gemini"]),
			},
		);

		await expect(store.claimDispatch({ jobId: "job_quality", version: 4 })).rejects.toMatchObject({
			code: "MEDIA_GENERATION_DISABLED",
		});
		expect(transaction.generationJob.updateMany).toHaveBeenCalledOnce();
	});

	it("blocks a queued Standard edit when production omits its launch switch", async () => {
		const transaction = {
			$executeRaw: vi.fn(async () => 0),
			generationJob: {
				findFirst: vi.fn(async () => ({
					id: "job_standard",
					version: 5,
					status: "DISPATCH_QUEUED",
					productKey: "image-fast",
					attempts: [],
					assets: [],
					quote: { costMicros: 4_000n },
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			runtimeConfigOverride: { findFirst: vi.fn(async () => null) },
			outboxEvent: { upsert: vi.fn(async () => ({})) },
		};
		const store = createDatabaseDispatchStore(
			{
				$transaction: async (callback: (value: typeof transaction) => unknown) =>
					callback(transaction),
			} as never,
			{
				environment: {
					NODE_ENV: "production",
					EZPIC_DEPLOYMENT_ENVIRONMENT: "production",
					MEDIA_GENERATION_ENABLED: "true",
				},
				enabledProviders: new Set(["replicate"]),
			},
		);

		await expect(store.claimDispatch({ jobId: "job_standard", version: 5 })).rejects.toMatchObject({
			code: "MEDIA_GENERATION_DISABLED",
		});
		expect(transaction.generationJob.updateMany).toHaveBeenCalledOnce();
	});
});
