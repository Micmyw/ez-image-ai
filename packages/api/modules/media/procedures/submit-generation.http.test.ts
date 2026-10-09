import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { runWithRequestDefer } from "@repo/utils/request-lifecycle";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	findQuote: vi.fn(),
	findLegacyQuote: vi.fn(),
	createQuote: vi.fn(),
	createJob: vi.fn(),
	wake: vi.fn(),
}));
vi.mock("@repo/auth", () => ({
	auth: {
		handler: vi.fn(),
		api: {
			getSession: vi.fn(async () => ({
				user: { id: "owner" },
				session: { id: "session" },
			})),
		},
	},
}));
vi.mock("@repo/database/client", () => ({
	db: { generationQuote: { findFirst: fixture.findLegacyQuote } },
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	findGenerationSubmissionQuote: fixture.findQuote,
	createGenerationJobTransaction: fixture.createJob,
}));
vi.mock("@repo/jobs", () => ({
	createProviderWebhookVerifierRegistry: () => ({ get: vi.fn(() => null) }),
}));
vi.mock("@repo/storage", () => ({
	checkStorageMetadataAccess: vi.fn(),
	putTemporaryReferenceObject: vi.fn(),
}));
vi.mock("@repo/payments", () => ({ paymentProviderNames: [], webhookHandler: vi.fn() }));
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: fixture.wake }));
vi.mock("@repo/logs", async (original) => ({
	...(await original<typeof import("@repo/logs")>()),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));
vi.mock("./create-quote", () => ({ createQuoteForUser: fixture.createQuote }));
vi.mock("../lib/generation-authorization", () => ({ assertGenerationAllowed: vi.fn() }));
vi.mock("../lib/plan-entitlement", () => ({
	loadUserPlanEntitlement: async () => ({ maximumConcurrentJobs: 3 }),
}));
vi.mock("../lib/rate-limit", () => ({ enforceMediaRateLimit: vi.fn() }));
vi.mock("../lib/executable-route-graph", () => ({
	getCurrentExecutableRouteGraphOptions: async () => ({
		enabledProviders: new Set(["kie"]),
		generationEnabled: true,
	}),
}));
vi.mock("./create-generation", async (original) => ({
	...(await original<typeof import("./create-generation")>()),
	createGenerationForUser: fixture.createJob,
}));
vi.mock("../../../orpc/router", async () => ({
	router: {
		media: {
			submitGeneration: (await import("./submit-generation")).submitGeneration,
			createGeneration: (await import("./create-generation")).createGeneration,
		},
	},
}));

import { logger } from "@repo/logs";

import { app } from "../../../index";
import { buildMediaQuote } from "../lib/quote";
import type { createGeneration } from "./create-generation";
import type { submitGeneration } from "./submit-generation";

const input = {
	productKey: "image-nano-banana-2-lite" as const,
	expectedCredits: "5",
	idempotencyKey: "http-submission",
	input: {
		kind: "text-to-image" as const,
		prompt: "PRIVATE",
		skuKey: "nano-banana-2-lite-1k" as const,
		aspectRatio: "auto" as const,
	},
};
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	fixture.findQuote.mockResolvedValue(null);
	fixture.findLegacyQuote.mockResolvedValue({
		...buildMediaQuote(input, { enabledProviders: new Set(["kie"]), generationEnabled: true }),
		id: "quote-legacy",
		inputSnapshot: input.input,
		expiresAt: new Date("2099-01-01"),
	});
	fixture.createQuote.mockResolvedValue({
		id: "quote-http",
		productKey: input.productKey,
		credits: 5n,
		expiresAt: new Date("2099-01-01"),
	});
	fixture.createJob.mockResolvedValue({
		job: { id: "job-http", status: "RESERVED", version: 1, creditsReserved: 5n },
		replayed: false,
		continuationEventIds: ["committed-http-event"],
	});
	fixture.wake.mockResolvedValue(undefined);
});

describe("managed generation HTTP admission", () => {
	it.each(["rpc", "openapi"])(
		"uses the managed wake for the old createGeneration %s handler",
		async (transport) => {
			const wake = deferred();
			fixture.wake.mockReturnValue(wake.promise);
			const pending: Promise<unknown>[] = [];
			const request = { quoteId: "quote-legacy", idempotencyKey: "legacy-http-request" };
			const result = await runWithRequestDefer(
				(task) => pending.push(task),
				async () => {
					if (transport === "rpc") {
						const client = createORPCClient<
							RouterClient<{ media: { createGeneration: typeof createGeneration } }>
						>(
							new RPCLink({
								url: "https://loopback.invalid/api/rpc",
								fetch: async (request) => app.fetch(request),
							}),
						);
						return client.media.createGeneration(request);
					}
					const response = await app.request("/api/media/generations", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(request),
					});
					expect(response.status).toBe(200);
					return response.json();
				},
			);
			expect(result).toMatchObject({ job: { id: "job-http" } });
			expect(pending).toHaveLength(1);
			expect(fixture.findLegacyQuote).toHaveBeenCalledTimes(1);
			expect(fixture.createJob).toHaveBeenCalledTimes(1);
			expect(
				vi.mocked(logger.info).mock.calls.some(([, fields]) => fields?.stage === "request.http"),
			).toBe(true);
			wake.resolve();
			await Promise.all(pending);
		},
	);
	it.each(["rpc", "openapi"])(
		"returns %s admission before wake and records separate HTTP/background boundaries",
		async (transport) => {
			const wake = deferred();
			fixture.wake.mockReturnValue(wake.promise);
			const pending: Promise<unknown>[] = [];
			const result = await runWithRequestDefer(
				(task) => pending.push(task),
				async () => {
					if (transport === "rpc") {
						const client = createORPCClient<
							RouterClient<{ media: { submitGeneration: typeof submitGeneration } }>
						>(
							new RPCLink({
								url: "https://loopback.invalid/api/rpc",
								headers: { "x-request-id": "c2-http" },
								fetch: async (request) => app.fetch(request),
							}),
						);
						return client.media.submitGeneration(input);
					}
					const response = await app.request("/api/media/generations/submit", {
						method: "POST",
						headers: { "content-type": "application/json", "x-request-id": "c2-http" },
						body: JSON.stringify(input),
					});
					expect(response.status).toBe(200);
					return response.json();
				},
			);
			expect(result).toMatchObject({ job: { id: "job-http", creditsReserved: "5" } });
			expect(pending).toHaveLength(1);
			expect(fixture.wake).toHaveBeenCalledWith(
				"media-deliver-events",
				{ eventIds: ["committed-http-event"] },
				{
					idempotencyKey: "generation-start:job-http:1",
					timeoutMs: 3000,
				},
			);
			const stages = () => vi.mocked(logger.info).mock.calls.map(([, fields]) => fields?.stage);
			expect(stages()).toContain("request.http");
			expect(stages()).toContain("admission.commit_to_wake.start");
			expect(stages()).not.toContain("background.dispatch");
			wake.resolve();
			await Promise.all(pending);
			expect(stages()).toContain("background.dispatch");
			expect(stages()).toContain("admission.commit_to_wake.complete");
			expect(stages()).not.toContain("admission.dispatch");
			expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("PRIVATE");
		},
	);

	it("waits for dispatch through the Node HTTP path", async () => {
		const wake = deferred();
		const started = deferred();
		fixture.wake.mockImplementation(() => {
			started.resolve();
			return wake.promise;
		});
		let returned = false;
		const response = Promise.resolve(
			app.request("/api/media/generations/submit", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			}),
		).then((response) => {
			returned = true;
			return response;
		});
		await started.promise;
		expect(returned).toBe(false);
		wake.resolve();
		expect((await response).status).toBe(200);
		expect(
			vi
				.mocked(logger.info)
				.mock.calls.some(([, fields]) => fields?.stage === "admission.dispatch"),
		).toBe(true);
	});
});
