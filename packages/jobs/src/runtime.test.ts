import {
	createRouteGraphSnapshot,
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	type CatalogRoute,
} from "@repo/ai";
import { describe, expect, it, vi } from "vitest";

import { deleteStorageObject } from "./handlers/cleanup-storage-object";
import {
	createDatabaseDispatchStore,
	createProviderRegistry,
	createReconciliationProviderRegistry,
	createProviderWebhookVerifierRegistry,
	createDatabaseStorageCleanupDependencies,
	resolveDatabaseDispatchRoute,
} from "./runtime";

const OPENROUTER_FAST_ROUTE = {
	provider: "openrouter",
	providerModelId: "sourceful/riverflow-v2.5-fast",
	providerCostMicros: 21_000,
	weight: 100,
} as const satisfies CatalogRoute;

const REPLICATE_FAST_ROUTE = {
	provider: "replicate",
	providerModelId: "black-forest-labs/flux-schnell",
	providerCostMicros: 3_000,
	weight: 80,
} as const satisfies CatalogRoute;

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

	it("registers OpenRouter only when it is configured and locally credentialed", () => {
		const registry = createProviderRegistry({
			NODE_ENV: "production",
			MEDIA_ENABLED_PROVIDERS: "openrouter",
			OPENROUTER_API_KEY: "openrouter-worker-secret",
		});

		expect([...registry.keys()]).toEqual(["openrouter"]);
		expect(registry.get("openrouter").provider).toBe("openrouter");
		expect(() =>
			createProviderRegistry({
				NODE_ENV: "production",
				MEDIA_ENABLED_PROVIDERS: "openrouter",
			}),
		).toThrow("PROVIDER_WORKER_CREDENTIAL_MISSING:openrouter");
	});

	it("rechecks OpenRouter certification for each frozen route resolution without affecting Replicate", async () => {
		const environment: Record<string, string | undefined> = {
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "false",
		};
		const openRouterDatabase = routeResolutionDatabase(
			frozenRouteJob("job_openrouter", [OPENROUTER_FAST_ROUTE]),
		);

		await expect(
			resolveDatabaseDispatchRoute("job_openrouter", {
				database: openRouterDatabase as never,
				environment,
				enabledProviders: new Set(["openrouter"]),
			}),
		).resolves.toBeNull();

		environment.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED = "true";
		await expect(
			resolveDatabaseDispatchRoute("job_openrouter", {
				database: openRouterDatabase as never,
				environment,
				enabledProviders: new Set(["openrouter"]),
			}),
		).resolves.toMatchObject({
			provider: "openrouter",
			providerModelId: OPENROUTER_FAST_ROUTE.providerModelId,
		});

		environment.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED = "false";
		await expect(
			resolveDatabaseDispatchRoute("job_replicate", {
				database: routeResolutionDatabase(
					frozenRouteJob("job_replicate", [REPLICATE_FAST_ROUTE]),
				) as never,
				environment,
				enabledProviders: new Set(["replicate"]),
			}),
		).resolves.toMatchObject({ provider: "replicate" });
	});

	it("rechecks OpenRouter certification for every claim on an existing worker store", async () => {
		const environment: Record<string, string | undefined> = {
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "false",
		};
		const database = dispatchDatabase(frozenRouteJob("job_openrouter", [OPENROUTER_FAST_ROUTE]));
		const store = createDatabaseDispatchStore(database as never, {
			environment,
			enabledProviders: new Set(["openrouter"]),
			createSignedReadUrl: async () => "https://private.example.test/signed-input",
		});

		await expect(store.claimDispatch({ jobId: "job_openrouter", version: 1 })).resolves.toBeNull();

		environment.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED = "true";
		await expect(
			store.claimDispatch({ jobId: "job_openrouter", version: 1 }),
		).resolves.toMatchObject({
			provider: "openrouter",
			providerModelId: OPENROUTER_FAST_ROUTE.providerModelId,
		});

		environment.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED = "false";
		await expect(store.claimDispatch({ jobId: "job_openrouter", version: 1 })).resolves.toBeNull();
	});

	it("rechecks OpenRouter certification before retry route reselection", async () => {
		const environment: Record<string, string | undefined> = {
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "false",
		};
		const database = retryDatabase(
			frozenRouteJob("job_retry", [REPLICATE_FAST_ROUTE, OPENROUTER_FAST_ROUTE]),
		);
		const store = createDatabaseDispatchStore(database as never, {
			environment,
			enabledProviders: new Set(["replicate", "openrouter"]),
		});

		await store.recordRejectedSubmission("attempt_false", retryableFailure());
		expect(database.transaction.generationAttempt.create).not.toHaveBeenCalled();

		environment.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED = "true";
		await store.recordRejectedSubmission("attempt_true", retryableFailure());
		expect(database.transaction.generationAttempt.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				provider: "openrouter",
				providerModelId: OPENROUTER_FAST_ROUTE.providerModelId,
			}),
		});
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

function frozenRouteJob(id: string, routes: readonly CatalogRoute[]) {
	const catalogVersion = "2026-08-31";
	const pricingVersion = "2026-08-31";
	return {
		id,
		ownerId: "user_1",
		version: 1,
		status: "DISPATCH_QUEUED",
		serviceClass: "STANDARD",
		productKey: "image-fast",
		catalogVersion,
		pricingVersion,
		inputSnapshot: {
			kind: "image-to-image",
			prompt: "Keep the subject",
			sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
		},
		pricingSnapshot: {
			routeGraph: createRouteGraphSnapshot({
				productKey: "image-fast",
				catalogVersion,
				pricingVersion,
				routes,
			}),
		},
		quote: { costMicros: BigInt(Math.max(...routes.map((route) => route.providerCostMicros))) },
		attempts: [],
		assets: [],
		guestTrial: null,
		reservation: { id: `reservation_${id}`, amount: 100n, status: "ACTIVE" },
	};
}

function routeResolutionDatabase(job: ReturnType<typeof frozenRouteJob>) {
	const transaction = {
		generationJob: {
			findUnique: vi.fn(async () => ({ ...job, attempts: [] })),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		generationAttempt: {
			create: vi.fn(async () => ({ id: "unavailable_attempt" })),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		auditLog: { create: vi.fn(async () => ({})) },
	};
	return {
		generationJob: { findUnique: vi.fn(async () => ({ ...job, attempts: [] })) },
		runtimeConfigOverride: { findFirst: vi.fn(async () => null) },
		$transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
	};
}

function dispatchDatabase(job: ReturnType<typeof frozenRouteJob>) {
	const verificationValidUntil = new Date(Date.now() + 60_000);
	const asset = {
		id: "asset_01J5ABCD1234EFGH5678JKLMNP",
		status: "READY",
		checksum: "input-checksum",
		kind: "IMAGE",
		objectKey: "users/user_1/assets/input.png",
		verificationValidUntil,
		verificationProvider: "test",
		verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
		verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
		verificationGeneration: 1,
		verificationAttemptCount: 1,
		verificationProviderTaskId: "verification-task",
		moderationResults: [
			{
				status: "APPROVED",
				verificationGeneration: 1,
				attemptNumber: 1,
				assetChecksum: "input-checksum",
				evidenceKind: "IMAGE",
				provider: "test",
				providerTaskId: "verification-task",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				validUntil: verificationValidUntil,
			},
		],
	};
	const transaction = {
		$executeRaw: vi.fn(async () => 0),
		generationJob: {
			findFirst: vi.fn(async () => ({ ...job, attempts: [] })),
			findUnique: vi.fn(async () => ({ ...job, attempts: [] })),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		generationAttempt: {
			create: vi.fn(async ({ data }: { data: { status?: string; attemptNumber: number } }) => ({
				id: data.status === "NEEDS_RECONCILIATION" ? "unavailable_attempt" : "claim_attempt",
				attemptNumber: data.attemptNumber,
			})),
			update: vi.fn(async () => ({})),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		generationJobAsset: {
			findFirst: vi.fn(async () => ({
				jobId: job.id,
				assetId: asset.id,
				role: "INPUT",
				assetChecksum: asset.checksum,
				asset,
			})),
		},
		runtimeConfigOverride: { findFirst: vi.fn(async () => null) },
		outboxEvent: { upsert: vi.fn(async () => ({})) },
		auditLog: { create: vi.fn(async () => ({})) },
	};
	return {
		transaction,
		$transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
	};
}

function retryDatabase(job: ReturnType<typeof frozenRouteJob>) {
	const attemptedRoute = {
		id: "attempt_replicate",
		jobId: job.id,
		attemptNumber: 1,
		provider: "replicate",
		providerModelId: REPLICATE_FAST_ROUTE.providerModelId,
		status: "SUBMITTING",
		errorSnapshot: {},
	};
	const transaction = {
		generationAttempt: {
			findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
				...attemptedRoute,
				id: where.id,
				job: { ...job, status: "SUBMITTING", attempts: [attemptedRoute] },
			})),
			update: vi.fn(async () => ({})),
			create: vi.fn(async () => ({})),
		},
		generationJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
		outboxEvent: { upsert: vi.fn(async () => ({})) },
	};
	return {
		transaction,
		$transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
	};
}

function retryableFailure() {
	return { code: "PROVIDER_TEMPORARY", message: "temporary rejection", retryable: true };
}
