import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	getSession: vi.fn(async () => ({ user: { id: "test-owner" }, session: { id: "test-session" } })),
	findFirst: vi.fn(async () => ({
		id: "test-job",
		status: "PROVIDER_RUNNING",
		version: 2,
		productKey: "legacy-product",
		inputSnapshot: { prompt: "never-log-content" },
		creditsReserved: 5n,
		failureCode: null,
		reservation: { status: "ACTIVE", settledAmount: 0n, releasedAmount: 0n },
		createdAt: new Date(0),
		updatedAt: new Date(1),
		_count: { attempts: 0 },
		attempts: [],
		assets: [],
	})),
}));
vi.mock("@repo/auth", () => ({
	auth: { handler: vi.fn(), api: { getSession: fixture.getSession } },
}));
vi.mock("@repo/config/server", async (original) => ({
	...(await original<typeof import("@repo/config/server")>()),
	validateEzPicLaunchEnvironment: vi.fn(),
	validateServerEnvironment: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({
	db: { generationJob: { findFirst: fixture.findFirst } },
}));
vi.mock("@repo/jobs", () => ({
	createProviderWebhookVerifierRegistry: () => ({ get: vi.fn(() => null) }),
}));
vi.mock("@repo/storage", () => ({
	createSignedReadUrl: vi.fn(),
	checkStorageMetadataAccess: vi.fn(),
	putTemporaryReferenceObject: vi.fn(),
}));
vi.mock("@repo/payments", () => ({ paymentProviderNames: [], webhookHandler: vi.fn() }));
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: vi.fn() }));
vi.mock("./orpc/router", async () => ({
	router: { media: { getJob: (await import("./modules/media/procedures/get-job")).getJob } },
}));

import { logger } from "@repo/logs";

import { app } from "./index";
import type { getJob } from "./modules/media/procedures/get-job";

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("NETWORK_FORBIDDEN_IN_HTTP_TEST");
		}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("media status HTTP boundary", () => {
	it("preserves private no-store through actual RPC encoding and records identity/response-ready spans", async () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => {});
		let responseHeaders: Headers | undefined;
		const client = createORPCClient<RouterClient<{ media: { getJob: typeof getJob } }>>(
			new RPCLink({
				url: "http://loopback.invalid/api/rpc",
				headers: { "x-request-id": "request-http-test" },
				fetch: async (request) => {
					const response = await app.fetch(request);
					responseHeaders = response.headers;
					return response;
				},
			}),
		);
		await expect(client.media.getJob({ jobId: "test-job" })).resolves.toMatchObject({
			id: "test-job",
		});
		expect(responseHeaders?.get("cache-control")).toBe("private, no-store");
		expect(responseHeaders?.get("x-request-id")).toBe("request-http-test");
		for (const stage of ["request.identity", "request.http"])
			expect(
				info.mock.calls.find(
					([message, fields]) => message === "media.flow.timing" && fields?.stage === stage,
				)?.[1],
			).toMatchObject({
				requestId: "request-http-test",
				stage,
				stageMs: expect.any(Number),
				connectionWaitMs: null,
				sqlExecutionMs: null,
			});
		expect(JSON.stringify(info.mock.calls)).not.toContain("never-log-content");
	});

	it("preserves private no-store on the OpenAPI response as well", async () => {
		const response = await app.request("/api/media/jobs/test-job");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({ id: "test-job" });
	});
});
