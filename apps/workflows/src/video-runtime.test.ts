import {
	VIDEO_RUNTIME_ENVIRONMENT_KEYS,
	VIDEO_PRIVATE_REFERENCE_ENVIRONMENT_KEYS,
} from "@repo/config/video-runtime-environment";
import {
	getVideoWorkflowBinding,
	getVideoWorkflowReadinessBindings,
} from "@repo/jobs/video-v1/workflow-binding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	database: vi.fn(),
	disconnect: vi.fn(),
	window: vi.fn(),
	checkpoint: vi.fn(),
	needsReview: vi.fn(),
	recoverExecutions: vi.fn(),
	recoverResources: vi.fn(),
}));

vi.mock("@repo/database/client", () => ({
	createRuntimeDatabaseClient: mocks.database,
	runWithDatabaseClient: (_database: unknown, operation: () => unknown) => operation(),
}));
vi.mock("@repo/database/video-v1-recovery", () => ({
	getVideoWaitWindow: mocks.window,
	getVideoWorkflowCheckpoint: mocks.checkpoint,
	markVideoNeedsReview: mocks.needsReview,
}));
vi.mock("@repo/jobs/video-v1/cleanup", () => ({
	recoverVideoResources: mocks.recoverResources,
}));
vi.mock("@repo/jobs/video-v1/recovery", () => ({
	recoverVideoExecutions: mocks.recoverExecutions,
}));
vi.mock("@repo/jobs/video-v1/fulfillment", () => ({
	failVideoJob: vi.fn(),
	finalizeVideoJob: vi.fn(),
	reviewStoredVideo: vi.fn(),
	storeVideoOutput: vi.fn(),
}));
vi.mock("@repo/jobs/video-v1/submission", () => ({
	confirmVideoProviderResult: vi.fn(),
	reviewVideoInput: vi.fn(),
	submitVideoAttempt: vi.fn(),
}));
vi.mock("@repo/jobs/video-v1/telemetry", () => ({ recordVideoStageMetric: vi.fn() }));
vi.mock("@repo/storage/image-processing/cloudflare-images", () => ({
	createCloudflareImagesProcessor: () => ({}),
}));
vi.mock("@repo/storage/image-processing/context", () => ({
	runWithImageProcessor: (_processor: unknown, operation: () => unknown) => operation(),
}));
vi.mock("@repo/storage/lib/cloudflare-remote-media", () => ({
	runWithCloudflareRemoteMedia: (operation: () => unknown) => operation(),
}));

import {
	runVideoMaintenance,
	videoWorkflowServices,
	withVideoRuntime,
	type VideoRuntimeEnvironment,
} from "./video-runtime";

function environment(video: Record<string, string | undefined> = {}): VideoRuntimeEnvironment {
	return {
		HYPERDRIVE: { connectionString: "test-only" },
		IMAGES: {} as VideoRuntimeEnvironment["IMAGES"],
		VIDEO_WORKFLOW: { create: vi.fn(), get: vi.fn() },
		VIDEO_MEDIA_BUCKET: {},
		...video,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of [
		...VIDEO_RUNTIME_ENVIRONMENT_KEYS,
		...VIDEO_PRIVATE_REFERENCE_ENVIRONMENT_KEYS,
		"VIDEO_RUNTIME_CONFIG",
		"VIDEO_V1_ENABLED",
		"HOTEL_LOBBY_DUO_ENABLED",
		"RUMPELSTILTSKIN_ENABLED",
	])
		vi.stubEnv(key, undefined);
	mocks.database.mockReturnValue({ $disconnect: mocks.disconnect });
	mocks.disconnect.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("video Worker runtime environment", () => {
	it("hydrates a resumed reference test with private bindings before database work and clears them", async () => {
		const privatePolicy = {
			RUMPELSTILTSKIN_ACCESS: "internal",
			RUMPELSTILTSKIN_ALLOWED_USER_IDS: "synthetic-tester",
			RUMPELSTILTSKIN_ACCEPTED_TEMPLATE_VERSION: "synthetic-version",
		};
		const bindings = {
			RUMPELSTILTSKIN_ENABLED: "true",
			RUMPELSTILTSKIN_APPROVED_MOTION_REFERENCE: '{"synthetic":"motion"}',
			RUMPELSTILTSKIN_COST_APPROVAL: '{"synthetic":"cost"}',
			VIDEO_RUNTIME_CONFIG: JSON.stringify(privatePolicy),
		};
		mocks.database.mockImplementationOnce(() => {
			for (const [key, value] of Object.entries({ ...bindings, ...privatePolicy }))
				expect(process.env[key]).toBe(value);
			return { $disconnect: mocks.disconnect };
		});
		await withVideoRuntime(environment(bindings), async () => undefined);
		await withVideoRuntime(environment(), async () => {
			expect(process.env.RUMPELSTILTSKIN_ENABLED).toBe("true");
			for (const key of [
				...Object.keys(privatePolicy),
				...VIDEO_PRIVATE_REFERENCE_ENVIRONMENT_KEYS,
			])
				expect(process.env[key]).toBeUndefined();
		});
		expect(mocks.disconnect).toHaveBeenCalledTimes(2);
	});
	it("reads packed timing before a native Workflow starts without an HTTP request", async () => {
		const env = environment({
			VIDEO_V1_ENABLED: "true",
			VIDEO_RUNTIME_CONFIG: JSON.stringify({
				VIDEO_V1_PROVIDER_POLL_SECONDS: "41",
				VIDEO_V1_MODERATION_POLL_SECONDS: "47",
				VIDEO_V1_PROVIDER_DEADLINE_SECONDS: "480",
				VIDEO_V1_MODERATION_DEADLINE_SECONDS: "900",
			}),
		});
		const services = videoWorkflowServices(env);
		expect(services.providerPollSeconds).toBe(41);
		expect(services.moderationPollSeconds).toBe(47);
		expect(mocks.database).not.toHaveBeenCalled();
		await services.window("job-native", "provider", 0);
		await services.window("job-native", "output", 1);
		expect(mocks.window.mock.calls.map(([input]) => input)).toEqual([
			{ jobId: "job-native", phase: "provider", round: 0, deadlineSeconds: 480 },
			{ jobId: "job-native", phase: "output", round: 1, deadlineSeconds: 900 },
		]);
		expect(mocks.disconnect).toHaveBeenCalledTimes(2);
	});

	it("hydrates each resumed operation before opening resources and uses packed CORS readiness", async () => {
		const env = environment({
			VIDEO_V1_ENABLED: "true",
			VIDEO_RUNTIME_CONFIG: JSON.stringify({
				VIDEO_V1_PROVIDER_CONCURRENCY: "4",
				VIDEO_V1_UPLOAD_CORS_READY: "true",
			}),
		});
		mocks.database.mockImplementation(() => {
			expect(process.env.VIDEO_V1_PROVIDER_CONCURRENCY).toBe("4");
			return { $disconnect: mocks.disconnect };
		});
		await withVideoRuntime(env, async () => {
			expect(process.env.VIDEO_V1_ENABLED).toBe("true");
			expect(getVideoWorkflowBinding()).toBe(env.VIDEO_WORKFLOW);
			expect(getVideoWorkflowReadinessBindings()).toEqual({
				workflow: true,
				r2: true,
				hyperdrive: true,
				uploadCors: true,
			});
		});
		expect(getVideoWorkflowReadinessBindings()).toEqual({});
		expect(mocks.disconnect).toHaveBeenCalledTimes(1);
	});

	it("clears stale policy and enable state when the next invocation omits them", async () => {
		await withVideoRuntime(
			environment({
				VIDEO_V1_ENABLED: "true",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_UPLOAD_CORS_READY: "true" }),
			}),
			async () => undefined,
		);
		await withVideoRuntime(environment(), async () => {
			expect(process.env.VIDEO_V1_ENABLED).toBe("false");
			expect(process.env.VIDEO_V1_UPLOAD_CORS_READY).toBeUndefined();
			expect(process.env.VIDEO_RUNTIME_CONFIG).toBeUndefined();
			expect(getVideoWorkflowReadinessBindings().uploadCors).toBe(false);
		});
	});

	it.each([
		{ VIDEO_RUNTIME_CONFIG: "not-json" },
		{
			VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_UPLOAD_CORS_READY: "true" }),
			VIDEO_V1_UPLOAD_CORS_READY: "false",
		},
	])(
		"closes invalid video policy without throwing at unrelated runtime consumers: %j",
		async (video) => {
			await withVideoRuntime(environment({ ...video, VIDEO_V1_ENABLED: "true" }), async () => {
				expect(process.env.VIDEO_V1_ENABLED).toBe("false");
				expect(process.env.VIDEO_RUNTIME_CONFIG).toBeUndefined();
				expect(process.env.VIDEO_V1_UPLOAD_CORS_READY).toBeUndefined();
				expect(getVideoWorkflowReadinessBindings().uploadCors).toBe(false);
			});
			expect(mocks.disconnect).toHaveBeenCalledTimes(1);
		},
	);

	it("hydrates scheduled recovery and cleanup without an earlier fetch", async () => {
		const env = environment({
			VIDEO_RUNTIME_CONFIG: JSON.stringify({
				VIDEO_V1_PROVIDER_CONCURRENCY: "2",
				VIDEO_V1_UPLOAD_CORS_READY: "true",
			}),
		});
		const recovery = async () => {
			expect(process.env.VIDEO_V1_PROVIDER_CONCURRENCY).toBe("2");
			expect(getVideoWorkflowReadinessBindings().uploadCors).toBe(true);
			return { recovered: 0 };
		};
		mocks.recoverExecutions.mockImplementation(recovery);
		mocks.recoverResources.mockImplementation(recovery);
		await expect(runVideoMaintenance(env)).resolves.toEqual([
			{ status: "fulfilled", value: { recovered: 0 } },
			{ status: "fulfilled", value: { recovered: 0 } },
		]);
		expect(mocks.recoverExecutions).toHaveBeenCalledWith(25, env.VIDEO_WORKFLOW);
		expect(mocks.recoverResources).toHaveBeenCalledWith(20);
		expect(mocks.disconnect).toHaveBeenCalledTimes(2);
	});
});
