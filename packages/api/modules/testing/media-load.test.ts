import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import { createMediaLoadTestHandler, resolveLoadTestConfiguration } from "./media-load";

const TOKEN = "hV5-P8LpyJEb8FeTQtvVNP6U3iRnH_wshmop_YmP5bx";
const DATABASE_URL = "postgresql://load:load@127.0.0.1:55432/ai_media_load_test";

function environment(overrides: Record<string, string | undefined> = {}) {
	return {
		NODE_ENV: "test",
		DATABASE_URL,
		LOAD_TEST_DATABASE_URL: DATABASE_URL,
		LOAD_TESTING_ENABLED: "true",
		LOAD_AUTH_TOKEN: TOKEN,
		LOAD_TEST_RUN_ID: "route-test-run",
		...overrides,
	};
}

function createApp(
	options: {
		environment?: Record<string, string | undefined>;
		execute?: () => Promise<{
			jobId: string;
			idempotencyKey: string;
			mode: "fast";
			status: string;
			replayed: boolean;
			internalQueueMs: number;
		}>;
		now?: () => number;
	} = {},
) {
	const app = new Hono();
	app.post(
		"/api/testing/media-load",
		createMediaLoadTestHandler({
			environment: () => options.environment ?? environment(),
			execute:
				options.execute ??
				(async () => ({
					jobId: "job-1",
					idempotencyKey: "k6:route-test-run:1:1",
					mode: "fast",
					status: "FINALIZING",
					replayed: false,
					internalQueueMs: 4,
				})),
			now: options.now ?? (() => 10_000),
		}),
	);
	return app;
}

function request(app: Hono, body = validBody(), token = TOKEN) {
	return app.request("/api/testing/media-load", {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body,
	});
}

function validBody() {
	return JSON.stringify({
		mode: "fast",
		idempotencyKey: "k6:route-test-run:1:1",
		prompt: "bounded deterministic load fixture",
	});
}

describe("media load-test safety boundary", () => {
	it("is indistinguishable from an absent route unless every load gate is valid", async () => {
		const disabledVariants = [
			environment({ LOAD_TESTING_ENABLED: "false" }),
			environment({ NODE_ENV: "production" }),
			environment({ LOAD_AUTH_TOKEN: "short" }),
			environment({ LOAD_TEST_RUN_ID: "bad run id" }),
			environment({ LOAD_TEST_DATABASE_URL: undefined }),
			environment({ DATABASE_URL: "postgresql://load:load@db.example.com/production" }),
		];
		for (const candidate of disabledVariants) {
			const response = await request(createApp({ environment: candidate }));
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ code: "NOT_FOUND" });
		}
	});

	it("requires a confirmed remote load database and never permits production mode", () => {
		const remote = "postgresql://load:load@db.example.com/staging_load";
		expect(
			resolveLoadTestConfiguration(
				environment({
					DATABASE_URL: remote,
					LOAD_TEST_DATABASE_URL: remote,
					LOAD_TEST_REMOTE_DATABASE_ENABLED: "true",
					LOAD_TEST_DATABASE_NAME_CONFIRMATION: "staging_load",
				}),
			),
		).toMatchObject({ runId: "route-test-run" });
		expect(
			resolveLoadTestConfiguration(
				environment({
					NODE_ENV: "production",
					DATABASE_URL: remote,
					LOAD_TEST_DATABASE_URL: remote,
					LOAD_TEST_REMOTE_DATABASE_ENABLED: "true",
					LOAD_TEST_DATABASE_NAME_CONFIRMATION: "staging_load",
				}),
			),
		).toBeNull();
	});

	it("rejects missing and incorrect credentials before executing", async () => {
		const execute = vi.fn();
		for (const supplied of ["", `${TOKEN}x`, "a".repeat(TOKEN.length)]) {
			const response = await request(createApp({ execute }), validBody(), supplied);
			expect(response.status).toBe(401);
		}
		expect(execute).not.toHaveBeenCalled();
	});

	it("bounds the body and requires the configured run prefix", async () => {
		const execute = vi.fn();
		const app = createApp({ execute });
		const oversized = await request(app, "x".repeat(4 * 1024 + 1));
		expect(oversized.status).toBe(413);
		const foreign = await request(
			app,
			JSON.stringify({ mode: "fast", idempotencyKey: "k6:foreign-run:1:1" }),
		);
		expect(foreign.status).toBe(400);
		expect(execute).not.toHaveBeenCalled();
	});

	it("enforces a bounded per-run rate before executing", async () => {
		const execute = vi.fn(async () => ({
			jobId: "job-1",
			idempotencyKey: "k6:route-test-run:1:1",
			mode: "fast" as const,
			status: "FINALIZING",
			replayed: false,
			internalQueueMs: 1,
		}));
		const app = createApp({
			environment: environment({ LOAD_TEST_RATE_LIMIT_PER_MINUTE: "1" }),
			execute,
		});
		expect((await request(app)).status).toBe(202);
		const limited = await request(app);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBe("60");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("enforces the concurrency cap and releases it after completion", async () => {
		let release!: () => void;
		const blocker = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execute = vi.fn(async () => {
			await blocker;
			return {
				jobId: "job-1",
				idempotencyKey: "k6:route-test-run:1:1",
				mode: "fast" as const,
				status: "FINALIZING",
				replayed: false,
				internalQueueMs: 1,
			};
		});
		const app = createApp({
			environment: environment({ LOAD_TEST_CONCURRENCY_LIMIT: "1" }),
			execute,
		});
		const first = request(app);
		await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		const limited = await request(app);
		expect(limited.status).toBe(429);
		release();
		expect((await first).status).toBe(202);
		expect((await request(app)).status).toBe(202);
	});

	it("returns only the bounded k6 response contract", async () => {
		const response = await request(createApp());
		expect(response.status).toBe(202);
		expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
		expect(response.headers.get("x-internal-queue-ms")).toBe("4");
		expect(await response.json()).toEqual({
			jobId: "job-1",
			idempotencyKey: "k6:route-test-run:1:1",
			mode: "fast",
			status: "FINALIZING",
			replayed: false,
			internalQueueMs: 4,
		});
	});
});
