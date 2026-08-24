import { describe, expect, it, vi } from "vitest";

import {
	createDatabaseDispatchStore,
	createProviderRegistry,
	createProviderWebhookVerifierRegistry,
} from "./runtime";

describe("provider runtime registration", () => {
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
});
