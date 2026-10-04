import { VIDEO_RUNTIME_ENVIRONMENT_KEYS } from "@repo/config/video-runtime-environment";
import {
	getVideoWorkflowBinding,
	getVideoWorkflowReadinessBindings,
} from "@repo/jobs/video-v1/workflow-binding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	createProcessor: vi.fn(),
	disconnect: vi.fn(),
}));

// The generated OpenNext artifact is absent before the application build.
vi.mock("./.open-next/worker.js", () => ({
	default: { fetch: mocks.fetch },
	DOQueueHandler: class {},
	DOShardedTagCache: class {},
}));
vi.mock("@repo/database/client", () => ({
	createLazyDatabaseClient: () => ({ $disconnect: mocks.disconnect }),
	createRuntimeDatabaseClient: vi.fn(),
	runWithDatabaseClient: (_client: unknown, operation: () => unknown) => operation(),
}));
vi.mock("@repo/storage/image-processing/cloudflare-images", () => ({
	createCloudflareImagesProcessor: mocks.createProcessor,
}));
vi.mock("@repo/storage/image-processing/context", () => ({
	runWithImageProcessor: (_processor: unknown, operation: () => unknown) => operation(),
}));
vi.mock("@repo/storage/lib/cloudflare-remote-media", () => ({
	runWithCloudflareRemoteMedia: (operation: () => unknown) => operation(),
}));

import worker from "../cloudflare-worker";

const ownedKeys = [...VIDEO_RUNTIME_ENVIRONMENT_KEYS, "VIDEO_RUNTIME_CONFIG", "VIDEO_V1_ENABLED"];
type Environment = Parameters<typeof worker.fetch>[1] & Record<string, unknown>;

function environment(overrides: Record<string, unknown> = {}): Environment {
	return {
		CANONICAL_ORIGIN: "https://ezpic.example",
		HYPERDRIVE: { connectionString: "test-only" },
		IMAGES: {} as Environment["IMAGES"],
		VIDEO_WORKFLOW: { create: vi.fn(), get: vi.fn() },
		VIDEO_MEDIA_BUCKET: {},
		...overrides,
	};
}

async function imageRequest(bindings: Environment) {
	const pending: Promise<unknown>[] = [];
	const response = await worker.fetch(new Request("https://ezpic.example/api/images"), bindings, {
		waitUntil: (promise) => pending.push(promise),
		passThroughOnException: vi.fn(),
	});
	const body = await response.text();
	await Promise.all(pending);
	return { response, body };
}

describe("website video runtime environment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const key of ownedKeys) vi.stubEnv(key, undefined);
		mocks.createProcessor.mockReturnValue({});
		mocks.disconnect.mockResolvedValue(undefined);
		mocks.fetch.mockResolvedValue(new Response("image route executed"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("hydrates packed video values before consumers and passes the expanded snapshot to OpenNext", async () => {
		const bindings = environment({
			VIDEO_V1_ENABLED: "true",
			VIDEO_RUNTIME_CONFIG: JSON.stringify({
				VIDEO_V1_UPLOAD_CORS_READY: "true",
				VIDEO_V1_PROVIDER_CONCURRENCY: "3",
			}),
		});
		mocks.createProcessor.mockImplementation(() => {
			expect(process.env.VIDEO_V1_PROVIDER_CONCURRENCY).toBe("3");
			expect(process.env.VIDEO_V1_UPLOAD_CORS_READY).toBe("true");
			return {};
		});
		mocks.fetch.mockImplementation(async (_request: Request, snapshot: Environment) => {
			expect(snapshot).not.toBe(bindings);
			expect(snapshot.VIDEO_V1_PROVIDER_CONCURRENCY).toBe("3");
			expect(snapshot.VIDEO_V1_UPLOAD_CORS_READY).toBe("true");
			expect(snapshot.VIDEO_V1_ENABLED).toBe("true");
			expect(getVideoWorkflowBinding()).toBe(bindings.VIDEO_WORKFLOW);
			expect(getVideoWorkflowReadinessBindings()).toEqual({
				workflow: true,
				r2: true,
				hyperdrive: true,
				uploadCors: true,
			});
			return new Response("image route executed");
		});

		const { response, body } = await imageRequest(bindings);
		expect(response.status).toBe(200);
		expect(body).toBe("image route executed");
		expect(bindings.VIDEO_V1_UPLOAD_CORS_READY).toBeUndefined();
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(mocks.disconnect).toHaveBeenCalledTimes(1);
		expect(getVideoWorkflowBinding()).toBeUndefined();
	});

	it.each([
		["malformed", { VIDEO_RUNTIME_CONFIG: "{" }],
		[
			"conflicting",
			{
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_UPLOAD_CORS_READY: "true" }),
				VIDEO_V1_UPLOAD_CORS_READY: "false",
			},
		],
	])(
		"keeps image handling available with %s video policy and sanitizes the OpenNext snapshot",
		async (_name, invalid) => {
			process.env.VIDEO_V1_PROVIDER_CONCURRENCY = "9";
			process.env.VIDEO_V1_ENABLED = "true";
			vi.stubEnv("MEDIA_IMAGE_TEST_SETTING", "preserved");
			const bindings = environment({ VIDEO_V1_ENABLED: "true", ...invalid });
			mocks.fetch.mockImplementation(async (_request: Request, snapshot: Environment) => {
				expect(snapshot.VIDEO_V1_ENABLED).toBe("false");
				expect(snapshot.VIDEO_RUNTIME_CONFIG).toBeUndefined();
				for (const key of VIDEO_RUNTIME_ENVIRONMENT_KEYS) {
					expect(snapshot[key]).toBeUndefined();
					expect(process.env[key]).toBeUndefined();
				}
				expect(process.env.VIDEO_V1_ENABLED).toBe("false");
				expect(process.env.VIDEO_RUNTIME_CONFIG).toBeUndefined();
				expect(process.env.MEDIA_IMAGE_TEST_SETTING).toBe("preserved");
				expect(snapshot.IMAGES).toBe(bindings.IMAGES);
				expect(getVideoWorkflowReadinessBindings().uploadCors).toBe(false);
				return new Response("image route executed");
			});

			const { response, body } = await imageRequest(bindings);
			expect(response.status).toBe(200);
			expect(body).toBe("image route executed");
			expect(mocks.fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("clears owned video settings when the next invocation has no video policy", async () => {
		mocks.fetch.mockImplementation(async () => new Response("image route executed"));
		await imageRequest(
			environment({
				VIDEO_V1_ENABLED: "true",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({
					VIDEO_V1_UPLOAD_CORS_READY: "true",
					VIDEO_V1_PROVIDER_CONCURRENCY: "3",
				}),
			}),
		);
		expect(process.env.VIDEO_V1_ENABLED).toBe("true");
		expect(process.env.VIDEO_V1_PROVIDER_CONCURRENCY).toBe("3");
		mocks.fetch.mockImplementation(async (_request: Request, snapshot: Environment) => {
			expect(snapshot.VIDEO_V1_ENABLED).toBe("false");
			expect(process.env.VIDEO_V1_ENABLED).toBe("false");
			expect(snapshot.VIDEO_RUNTIME_CONFIG).toBeUndefined();
			expect(process.env.VIDEO_RUNTIME_CONFIG).toBeUndefined();
			for (const key of VIDEO_RUNTIME_ENVIRONMENT_KEYS) {
				expect(snapshot[key]).toBeUndefined();
				expect(process.env[key]).toBeUndefined();
			}
			expect(getVideoWorkflowReadinessBindings().uploadCors).toBe(false);
			return new Response("image route executed");
		});

		const { response, body } = await imageRequest(environment());
		expect(response.status).toBe(200);
		expect(body).toBe("image route executed");
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});
});
